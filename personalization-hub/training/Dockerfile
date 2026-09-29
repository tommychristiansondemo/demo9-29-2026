FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir "psycopg[binary]>=3.1" "boto3>=1.34" "numpy>=1.26"

COPY train.py ./

CMD ["python", "train.py"]
