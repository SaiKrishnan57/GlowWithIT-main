from django.db import models
from urllib.parse import urlparse
from django.core.validators import MinValueValidator, MaxValueValidator
from django.utils import timezone
from datetime import timedelta

import uuid, hashlib, os

"""
This model is used for storing insights and resources for to night shift workers.
It represents news articles, reports, or external website urls that provide
information or awareness content.
"""


class NightWorkerInsight(models.Model):

    # primary key (PK)
    insight_id = models.AutoField(primary_key=True)
    # title column
    title = models.CharField(max_length=255)
    # description column
    description = models.TextField(blank=True)
    # source column
    source = models.CharField(max_length=512, blank=True)
    # date of publish column
    published_date = models.DateField(null=True, blank=True)

    class Meta:
        # Explicitly map this model to the night_worker_insights table.
        db_table = "night_worker_insights"
        # explicitly tell django not to manage the lifecycle of this db
        managed = False
        # ordering logic when executing the query
        # first by published_date, and second order by insight_id
        ordering = ["-published_date", "-insight_id"]

    @property
    def source_is_url(self):
        """
        Returns True if source looks like a valid HTTP/HTTPS url.
        """
        urlAddress = (self.source or "").lower()
        return urlAddress.startswith("http://") or urlAddress.startswith("https://")

    @property
    def source_domain(self):
        """
        Returns the domain name if source is a url.
        And falls back to returning the raw source if parsing fails.
        """
        try:
            domain_address = urlparse(self.source or "").netloc
            return domain_address.replace("www.", "") or (self.source or "")
        except Exception:
            return self.source


OSM_TYPE_CHOICES = (("node", "node"), ("way", "way"), ("relation", "relation"))


class GeoPoint(models.Model):
    geo_id = models.BigAutoField(primary_key=True)
    lon = models.FloatField()
    lat = models.FloatField()
    # MySQL geometry stored as binary; fetch lon/lat via ST_X/ST_Y in SQL.
    geom = models.BinaryField(editable=False)

    class Meta:
        managed = False
        db_table = "geo_points"

    def __str__(self):
        return f"GeoPoint #{self.geo_id} ({self.lon}, {self.lat})"


class GeoLine(models.Model):
    geo_id = models.BigAutoField(primary_key=True)
    # MySQL LINESTRING (SRID 4326) stored as binary.
    geom = models.BinaryField(editable=False)

    class Meta:
        managed = False
        db_table = "geo_lines"

    def __str__(self):
        return f"GeoLine #{self.geo_id}"


class VenueCBDStage(models.Model):
    """
    New normalized venues table (no lat/long columns; uses geo_id FK).
    Mirrors your `venues_cbd` schema.
    """
    osm_id = models.BigIntegerField(primary_key=True)
    osm_type = models.CharField(max_length=16, null=True, blank=True)
    name = models.CharField(max_length=255, null=True, blank=True)
    venue_type = models.CharField(max_length=64, null=True, blank=True)
    address = models.CharField(max_length=512, null=True, blank=True)
    opening_hours_raw = models.CharField(max_length=512, null=True, blank=True)
    mon = models.CharField(max_length=32, null=True, blank=True)
    tue = models.CharField(max_length=32, null=True, blank=True)
    wed = models.CharField(max_length=32, null=True, blank=True)
    thu = models.CharField(max_length=32, null=True, blank=True)
    fri = models.CharField(max_length=32, null=True, blank=True)
    sat = models.CharField(max_length=32, null=True, blank=True)
    sun = models.CharField(max_length=32, null=True, blank=True)

    geo = models.ForeignKey(
        GeoPoint,
        db_column="geo_id",
        on_delete=models.RESTRICT,
        related_name="venues_stage",
    )

    class Meta:
        managed = False
        db_table = "venues_cbd"

    def __str__(self):
        return f"{self.name or self.venue_type or 'Venue'} ({self.osm_id})"

    @property
    def lon(self):
        return None if self.geo_id is None else self.geo.lon

    @property
    def lat(self):
        return None if self.geo_id is None else self.geo.lat


class LightingLamp(models.Model):
    """
    Street-lamp point features. Geometry via geo_points (geo_id).
    """
    osm_id = models.BigIntegerField(primary_key=True)
    tags = models.JSONField(null=True, blank=True)
    geo = models.ForeignKey(
        GeoPoint,
        db_column="geo_id",
        on_delete=models.RESTRICT,
        related_name="lighting_lamps",
    )
    source = models.CharField(max_length=32, default="overpass", blank=True)
    updated_at = models.DateTimeField()

    class Meta:
        managed = False
        db_table = "lighting_lamps"

    def __str__(self):
        return f"Lamp {self.osm_id}"

    @property
    def lon(self):
        return None if self.geo_id is None else self.geo.lon

    @property
    def lat(self):
        return None if self.geo_id is None else self.geo.lat


class LightingLitway(models.Model):
    """
    Lit road segments. Geometry via geo_lines (geo_id).
    """
    osm_id = models.BigIntegerField(primary_key=True)
    tags = models.JSONField(null=True, blank=True)
    geo = models.ForeignKey(
        GeoLine,
        db_column="geo_id",
        on_delete=models.RESTRICT,
        related_name="lighting_litways",
    )
    source = models.CharField(max_length=32, default="overpass", blank=True)
    updated_at = models.DateTimeField()

    class Meta:
        managed = False
        db_table = "lighting_litways"

    def __str__(self):
        return f"Litway {self.osm_id}"


class VenueCBD(models.Model):
    """
    Main CBD venue table. Mirrors the MySQL schema we created.
    We use a surrogate PK and enforce uniqueness on (osm_type, osm_id).
    """

    id = models.BigAutoField(primary_key=True)
    osm_id = models.BigIntegerField()
    osm_type = models.CharField(max_length=8, choices=OSM_TYPE_CHOICES)

    name = models.CharField(max_length=255, null=True, blank=True)
    venue_type = models.CharField(max_length=100, null=True, blank=True)
    address = models.CharField(max_length=255, null=True, blank=True)

    latitude = models.DecimalField(
        max_digits=9,
        decimal_places=6,
        validators=[MinValueValidator(-90), MaxValueValidator(90)],
    )
    longitude = models.DecimalField(
        max_digits=9,
        decimal_places=6,
        validators=[MinValueValidator(-180), MaxValueValidator(180)],
    )

    opening_hours_raw = models.CharField(max_length=255, null=True, blank=True)
    mon = models.CharField(max_length=64, null=True, blank=True)
    tue = models.CharField(max_length=64, null=True, blank=True)
    wed = models.CharField(max_length=64, null=True, blank=True)
    thu = models.CharField(max_length=64, null=True, blank=True)
    fri = models.CharField(max_length=64, null=True, blank=True)
    sat = models.CharField(max_length=64, null=True, blank=True)
    sun = models.CharField(max_length=64, null=True, blank=True)

    class Meta:
        db_table = "venue_cbd"
        constraints = [
            models.UniqueConstraint(
                fields=["osm_type", "osm_id"], name="uniq_venue_cbd_osmtype_osmid"
            ),
        ]
        indexes = [
            models.Index(fields=["name"], name="idx_venue_cbd_name"),
            models.Index(fields=["venue_type"], name="idx_venue_cbd_type"),
            models.Index(fields=["latitude", "longitude"], name="idx_venue_cbd_latlon"),
        ]

    def __str__(self):
        return (
            f"{self.name or self.venue_type or 'Venue'} ({self.osm_type}:{self.osm_id})"
        )

   
    def is_24_7(self) -> bool:
        days = [self.mon, self.tue, self.wed, self.thu, self.fri, self.sat, self.sun]
        return all(d == "24/7" for d in days if d)

    def is_24_7_on(self, day_code: str) -> bool:
        # day_code in {"mon","tue","wed","thu","fri","sat","sun"}
        return (getattr(self, day_code.lower(), None) or "").strip() == "24/7"

    @classmethod
    def upsert_from_dict(cls, rec: dict):
        """
        Safe upsert that mirrors our SQL `ON DUPLICATE KEY UPDATE`.
        Usage: VenueCBD.upsert_from_dict({...})
        """
        keys = dict(osm_type=rec["osm_type"], osm_id=rec["osm_id"])
        defaults = {
            "name": rec.get("name"),
            "venue_type": rec.get("venue_type"),
            "address": rec.get("address"),
            "latitude": rec.get("latitude"),
            "longitude": rec.get("longitude"),
            "opening_hours_raw": rec.get("opening_hours_raw"),
            "mon": rec.get("mon"),
            "tue": rec.get("tue"),
            "wed": rec.get("wed"),
            "thu": rec.get("thu"),
            "fri": rec.get("fri"),
            "sat": rec.get("sat"),
            "sun": rec.get("sun"),
        }
        obj, _created = cls.objects.update_or_create(defaults=defaults, **keys)
        return obj





class HazardReport(models.Model):
    
    public_id   = models.UUIDField(default=uuid.uuid4, editable=False, unique=True)
    lat         = models.DecimalField(max_digits=9, decimal_places=6)
    lng         = models.DecimalField(max_digits=9, decimal_places=6)
    kind        = models.CharField(max_length=32, blank=True)        
    note_short  = models.CharField(max_length=140, blank=True)
    severity    = models.PositiveSmallIntegerField(default=1)         
    ttl_secs    = models.PositiveIntegerField(default=1800)
    created_at  = models.DateTimeField(auto_now_add=True)
    expires_at  = models.DateTimeField()


    fp = models.CharField(max_length=64, blank=True, db_index=True)

    class Meta:
        indexes = [
            models.Index(fields=["expires_at"]),
            models.Index(fields=["lat", "lng"]),
        ]

    def save(self, *args, **kwargs):
        if not self.expires_at:
            self.expires_at = timezone.now() + timedelta(seconds=self.ttl_secs)
        super().save(*args, **kwargs)

    @classmethod
    def active(cls):
        return cls.objects.filter(expires_at__gt=timezone.now())

