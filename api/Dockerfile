FROM python:3.12-slim

ARG VCS_REF=dev
ARG BUILD_TIME=unknown
LABEL org.opencontainers.image.revision=$VCS_REF \
      org.opencontainers.image.created=$BUILD_TIME \
      org.opencontainers.image.source="https://github.com/joelmale/sentinel"
ENV VCS_REF=$VCS_REF \
    BUILD_TIME=$BUILD_TIME

WORKDIR /app

# System deps for asyncpg + shapely
RUN apt-get update && apt-get install -y \
    gcc libgeos-dev curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
