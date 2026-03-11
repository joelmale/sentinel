FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y gcc curl && rm -rf /var/lib/apt/lists/*

# Copy shared base first (layer cache optimization)
COPY base/requirements.txt /app/base/requirements.txt
RUN pip install --no-cache-dir -r /app/base/requirements.txt

COPY adsb/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY base/base_collector.py /app/base/base_collector.py
COPY adsb/collector.py ./collector.py

CMD ["python", "collector.py"]
