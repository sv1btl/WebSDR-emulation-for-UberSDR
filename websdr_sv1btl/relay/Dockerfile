# WebSDR relay for Receive Diversity (PhantomSDR-Plus websdr_relay.py, GNU GPL v3).
# Build: docker build -t websdr-relay ~/ubersdr/websdr_sv1btl/relay
FROM python:3.12-slim
RUN pip install --no-cache-dir aiohttp==3.10.10
WORKDIR /app
CMD ["python3", "/app/websdr_relay.py"]
