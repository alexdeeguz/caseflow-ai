from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[3]


class TemplateLoader(yaml.SafeLoader):
    pass


def load(path):
    TemplateLoader.add_multi_constructor(
        "!",
        lambda loader, tag, node: (
            {tag: loader.construct_scalar(node)}
            if isinstance(node, yaml.ScalarNode)
            else {tag: loader.construct_sequence(node)}
        ),
    )
    return yaml.load((ROOT / path).read_text(), Loader=TemplateLoader)


def test_runtime_permissions_and_no_reserved_capacity():
    template = load("infra/application/template.yaml")
    resources = template["Resources"]
    for name in ["ApiFunction", "DispatcherFunction"]:
        props = resources[name]["Properties"]
        assert "ReservedConcurrentExecutions" not in props
        assert props["AutoPublishAlias"] == "live"
    assert resources["DispatcherFunction"]["Properties"]["Events"]["Tick"][
        "Properties"
    ]["State"] == {"Ref": "DispatcherState"}
    assert template["Parameters"]["DispatcherState"]["Default"] == "DISABLED"
    for name in ["ApiRole", "DispatcherRole"]:
        statements = resources[name]["Properties"]["Policies"][0]["PolicyDocument"][
            "Statement"
        ]
        assert all(statement["Resource"] != "*" for statement in statements)
        actions = str(statements)
        assert "DeleteObject" not in actions
        assert "PassRole" not in actions
    assert resources["HttpApi"]["Properties"]["CorsConfiguration"]["AllowOrigins"] == [
        {"Ref": "WebOrigin"}
    ]


def test_release_requires_successful_main_push_and_exact_test_artifact():
    workflow = load(".github/workflows/deploy.yml")
    jobs = workflow["jobs"]
    condition = jobs["verify"]["if"]
    assert "conclusion == 'success'" in condition
    assert "event == 'push'" in condition
    assert "head_branch == 'main'" in condition
    assert "head_repository.full_name == github.repository" in condition
    assert jobs["aws"]["needs"] == "verify"
    assert jobs["web"]["needs"] == ["verify", "aws"]
    artifact = next(
        step
        for step in jobs["aws"]["steps"]
        if step.get("name", "").startswith("Download")
    )
    assert artifact["with"]["run-id"] == "${{ github.event.workflow_run.id }}"
    assert workflow["concurrency"]["cancel-in-progress"] is False
    assert jobs["web"]["steps"][-1]["run"] == "vercel deploy --prebuilt --prod"


def test_runner_has_only_code_release_and_connection_permissions():
    template = load("infra/application/runner.yaml")
    statements = template["Resources"]["RunnerRole"]["Properties"]["Policies"][0][
        "PolicyDocument"
    ]["Statement"]
    wildcard = [statement for statement in statements if statement["Resource"] == "*"]
    assert len(wildcard) == 1
    assert wildcard[0]["Action"] == "ecr:GetAuthorizationToken"
    actions = str(statements)
    for forbidden in [
        "secretsmanager:",
        "s3:",
        "iam:",
        "UpdateFunctionConfiguration",
        "CreateFunction",
    ]:
        assert forbidden not in actions
    filters = template["Resources"]["Runner"]["Properties"]["Triggers"]["FilterGroups"][
        0
    ]
    assert {item["Type"] for item in filters} == {
        "EVENT",
        "WORKFLOW_NAME",
        "ACTOR_ACCOUNT_ID",
    }


def test_container_and_gate_cover_the_current_application():
    template = load("infra/application/template.yaml")
    api = template["Resources"]["ApiFunction"]["Properties"]
    assert api["PackageType"] == "Image"
    assert api["ImageUri"] == {"Ref": "ApiImageUri"}
    assert "Runtime" not in template["Globals"]["Function"]
    assert "Handler" not in template["Globals"]["Function"]
    assert template["Parameters"]["DemoLoginEnabled"]["Default"] == "false"
    variables = api["Environment"]["Variables"]
    assert variables["DEMO_LOGIN_ENABLED"] == {"Ref": "DemoLoginEnabled"}
    assert "DEMO_SESSION_SECRET" not in variables
    assert "@sha256:" in template["Parameters"]["ApiImageUri"]["AllowedPattern"]
    repository = load("infra/application/runner.yaml")["Resources"]["ApiRepository"]
    assert repository["Properties"]["ImageTagMutability"] == "IMMUTABLE"
    assert repository["DeletionPolicy"] == "Retain"

    ci = load(".github/workflows/test-and-build.yml")["jobs"]
    assert ci["build"]["needs"] == ["unit", "integration", "lambda"]
    commands = "\n".join(step.get("run", "") for step in ci["build"]["steps"])
    assert "--platform linux/amd64 --provenance=false --load" in commands
    assert "verify-image.mjs" in commands
    assert commands.index("verify-image.mjs") < commands.index("package.mjs")
    integration = str(ci["integration"])
    assert "services/search-indexer" in integration
    assert "services/fact-extractor" in integration
    assert "services/document-processor" in integration
