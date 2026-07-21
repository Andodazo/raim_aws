# syntax=docker/dockerfile:1

ARG VOICEVOX_VERSION=0.15.4

FROM debian:bookworm-slim AS voicevox
ARG VOICEVOX_VERSION

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl tar unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/voicevox

RUN curl -fsSL -o voicevox_core.zip \
      "https://github.com/VOICEVOX/voicevox_core/releases/download/${VOICEVOX_VERSION}/voicevox_core-linux-arm64-cpu-${VOICEVOX_VERSION}.zip" \
    && unzip voicevox_core.zip \
    && rm voicevox_core.zip \
    && mv "voicevox_core-linux-arm64-cpu-${VOICEVOX_VERSION}" voicevox_core

RUN curl -fsSL -o open_jtalk_dic.tar.gz \
      "https://sourceforge.net/projects/open-jtalk/files/Dictionary/open_jtalk_dic-1.11/open_jtalk_dic_utf_8-1.11.tar.gz/download" \
    && tar xzf open_jtalk_dic.tar.gz \
    && rm open_jtalk_dic.tar.gz

FROM rust:1.80-bookworm AS builder

WORKDIR /build

# vvcore 0.0.2 emits a relative linker search path: voicevox_core.
# Keep the library at the project-root-relative path expected during linking.
COPY --from=voicevox /opt/voicevox/voicevox_core ./voicevox_core
ENV LD_LIBRARY_PATH=/build/voicevox_core

COPY Cargo.toml ./
COPY src ./src

RUN cargo build --release

FROM builder AS test
RUN cargo test

FROM public.ecr.aws/lambda/provided:al2023 AS runtime

COPY --from=voicevox /opt/voicevox ${LAMBDA_TASK_ROOT}/voicevox
COPY --from=builder /build/target/release/raim-tts-lambda ${LAMBDA_TASK_ROOT}/bootstrap

RUN chmod 755 ${LAMBDA_TASK_ROOT}/bootstrap

ENV MAX_TEXT_CHARS=200 \
    MAX_WAV_BYTES=4194304 \
    VOICEVOX_CPU_THREADS=6 \
    OPEN_JTALK_DICT_DIR=/var/task/voicevox/open_jtalk_dic_utf_8-1.11 \
    LD_LIBRARY_PATH=/var/task/voicevox/voicevox_core

CMD ["bootstrap"]
