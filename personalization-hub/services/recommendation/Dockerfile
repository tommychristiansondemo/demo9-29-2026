FROM python:3.12-slim

WORKDIR /app

COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir .

ENV APP_VERSION=prod
EXPOSE 8080

CMD ["uvicorn", "rec.app:app", "--host", "0.0.0.0", "--port", "8080"]
