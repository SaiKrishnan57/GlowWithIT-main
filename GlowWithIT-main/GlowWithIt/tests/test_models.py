from django.test import TestCase
from django.apps import apps
from django.utils import timezone
import uuid
import datetime as dt

# ---------- Helpers to build minimal instances for unknown schemas ----------

_NUMERIC_TYPES = {
    "IntegerField", "BigIntegerField", "SmallIntegerField",
    "PositiveIntegerField", "PositiveSmallIntegerField", "AutoField",
}
_DECIMAL_TYPES = {"FloatField", "DecimalField"}
_TEXT_TYPES = {"CharField", "TextField", "SlugField"}
_DATE_TYPES = {"DateField"}
_DATETIME_TYPES = {"DateTimeField"}
_JSON_TYPES = {"JSONField"}
_BOOL_TYPES = {"BooleanField", "NullBooleanField"}
_URL_TYPES = {"URLField"}
_EMAIL_TYPES = {"EmailField"}
_UUID_TYPES = {"UUIDField"}


def _default_for_field(f):

    """Return a safe default value for a model field."""
    t = f.get_internal_type()

    if t in _TEXT_TYPES:
        # Keep it short for CharField; Django will enforce max_length if present.
        return "x"
    if t in _NUMERIC_TYPES:
        return 1
    if t in _DECIMAL_TYPES:
        return 1.0
    if t in _DATE_TYPES:
        return dt.date.today()
    if t in _DATETIME_TYPES:
        return timezone.now()
    if t in _JSON_TYPES:
        return {}
    if t in _BOOL_TYPES:
        return True
    if t in _URL_TYPES:
        return "https://example.com"
    if t in _EMAIL_TYPES:
        return "user@example.com"
    if t in _UUID_TYPES:
        return uuid.uuid4()

    # Fallback: text
    return "x"




#Test VenueCBD table
class VenueCBDModelTests(TestCase):

   

    @classmethod
    def setUpTestData(cls):

        VenueCBD = apps.get_model("GlowWithIt", "VenueCBD")

        cls.venue = VenueCBD.objects.create(

            osm_type="node",
            osm_id=123456789,     
            name="Test Safe Venue",
            venue_type="safety",   
            address="123 Test St, Melbourne VIC",
            latitude=-37.8100,
            longitude=144.9600,
            mon="09:00-17:00",
            tue="09:00-17:00",
            wed="09:00-17:00",
            thu="09:00-17:00",
            fri="09:00-17:00",
            sat="",
            sun="",
        )

    def test_saved_and_retrieved(self):

        VenueCBD = type(self.venue)
        rows = VenueCBD.objects.all()
        self.assertEqual(rows.count(), 1)

        v = rows.first()
        self.assertEqual(v.name, "Test Safe Venue")
        # Ensure lat/lon numeric-ish and within Victoria-ish bounds
        self.assertTrue(-39.5 <= float(v.latitude) <= -34.0)
        self.assertTrue(140.0 <= float(v.longitude) <= 150.5)

    def test_hours_fields_present(self):
        v = self.venue
        # Views rely on all seven day fields being present
        for day in ("mon", "tue", "wed", "thu", "fri", "sat", "sun"):
            self.assertTrue(hasattr(v, day), f"Missing hours field: {day}")

#Test NightWorkerInsight table
class NightWorkerInsightModelTests(TestCase):
    

    def test_model_exists(self):
        model = apps.get_model("GlowWithIt", "NightWorkerInsight")
        self.assertIsNotNone(model)

    def test_can_create_minimal_instance_if_no_required_fk(self):
        Model = apps.get_model("GlowWithIt", "NightWorkerInsight")

        #
        fields = [
            f for f in Model._meta.get_fields()
            if getattr(f, "concrete", False)
            and not getattr(f, "auto_created", False)
            and not getattr(f, "many_to_many", False)
        ]

        kwargs = {}
        requires_fk = False

        for f in fields:
            if getattr(f, "primary_key", False) and getattr(f, "auto_created", False):
                # Skip implicit PKs
                continue

            # If nullable or has a default, we can omit it
            if getattr(f, "null", False) or getattr(f, "blank", False) or f.has_default():
                continue

            # ForeignKey without null/default is hard to satisfy generically
            if f.get_internal_type() == "ForeignKey":
                requires_fk = True
                break

            # Provide a sensible default
            kwargs[f.name] = _default_for_field(f)

        if requires_fk:

            self.skipTest("NightWorkerInsight has required FK(s) – provide factory or relax nulls for unit tests.")

        # Create + fetch back
        obj = Model.objects.create(**kwargs)

        self.assertIsNotNone(obj.pk)

        again = Model.objects.get(pk=obj.pk)

        self.assertEqual(again.pk, obj.pk)
