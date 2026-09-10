FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pil ffmpeg fonts-dejavu-core fonts-noto-color-emoji && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --chmod=644 server.py /app/server.py
COPY --chmod=644 fonts/ /app/fonts/
RUN chmod 755 /app/fonts && useradd --uid 10001 --create-home renderer
USER renderer
EXPOSE 8080
CMD ["python3", "server.py"]

FROM runtime AS test
COPY --chmod=644 test_renderer.py /app/test_renderer.py

FROM runtime AS production
