# ---- Base image ----
FROM python:3.12-slim


WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DJANGO_SETTINGS_MODULE=GlowWithIt.settings

# Install system dependencies 
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*


COPY requirements.txt .

# Install python dependencies from requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copy project code
COPY . .

# Collect static files from settings.py
RUN python manage.py collectstatic --noinput

EXPOSE 8000

# entrypoint
CMD ["gunicorn", "GlowWithIt.wsgi:application", "--bind", "0.0.0.0:8000", "--workers", "3", "--timeout", "60"]
