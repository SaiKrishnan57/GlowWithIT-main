from django.contrib import admin
from .models import NightWorkerInsight


@admin.register(NightWorkerInsight)
class NightWorkerInsightAdmin(admin.ModelAdmin):

    list_display = ("title", "source", "published_date")
    search_fields = ("title", "description", "source")
    list_filter = ("published_date",)
