FROM public.ecr.aws/lambda/nodejs:24@sha256:7cdb66735cb609e6d79c4b5b198399427fa50599e08711adb5ed444840098b6e

COPY dist-lambda/ ${LAMBDA_TASK_ROOT}/

CMD ["index.handler"]
