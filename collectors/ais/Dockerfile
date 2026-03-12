FROM python:3.12-slim

ARG VCS_REF=dev
ARG BUILD_TIME=unknown
LABEL org.opencontainers.image.revision=$VCS_REF \
      org.opencontainers.image.created=$BUILD_TIME \
      org.opencontainers.image.source="https://github.com/joelmale/sentinel"
ENV VCS_REF=$VCS_REF \
    BUILD_TIME=$BUILD_TIME

WORKDIR /app
RUN apt-get update && apt-get install -y gcc curl && rm -rf /var/lib/apt/lists/*
COPY base/requirements.txt /app/base/requirements.txt
RUN pip install --no-cache-dir -r /app/base/requirements.txt
COPY ais/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY base/base_collector.py /app/base/base_collector.py
COPY ais/collector.py ./collector.py
CMD ["python", "collector.py"]
