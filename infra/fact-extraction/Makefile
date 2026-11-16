.PHONY: build-ExtractorFunction

build-ExtractorFunction:
	python3.13 -m pip install --disable-pip-version-check --no-compile --require-hashes --only-binary=:all: --target "$(ARTIFACTS_DIR)" -r requirements.txt
	cp -R caseflow_facts "$(ARTIFACTS_DIR)/"
