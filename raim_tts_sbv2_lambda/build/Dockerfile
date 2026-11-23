# zip に入れる site-packages を作るためだけのイメージ（このイメージ自体はデプロイしない）。
# Lambda と同じ Amazon Linux 2023 / Python 3.12 で pip install して、site-packages を取り出す。
#
#   docker build -t raim-tts-sbv2-build -f build/Dockerfile build
#   docker create --name raim-tts-sbv2-build raim-tts-sbv2-build
#   docker cp raim-tts-sbv2-build:/var/lang/lib/python3.12/site-packages build/raw/site-packages
#   docker rm raim-tts-sbv2-build
FROM public.ecr.aws/lambda/python:3.12

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt \
    && pip install --no-cache-dir --no-deps num2words==0.5.14
