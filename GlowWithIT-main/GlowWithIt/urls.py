from django.contrib import admin
from django.urls import path
from .views import home, crime_heatmap, insight, score_google_routes,support,lighting_geojson,disruptions_along_route,hazards_create,hazards_active,api_venues,voice_call,landing_fakecall,ped_live

urlpatterns = [
    path("admin/", admin.site.urls),
    path("", home, name="home"),
    path("api/heatmap/crime/", crime_heatmap, name="crime-heatmap"),  
    path("insight/", insight, name="insight"),  
    path("support/",support, name="support"),                    
    path("data/lighting.geojson",lighting_geojson, name="lighting_geojson"),
    path("api/disruptions/along-route", disruptions_along_route, name="disruptions_along_route"),
    path("api/venues", api_venues, name="api_venues"),
     path("simulator/", landing_fakecall, name="landing_fakecall"),  # marketing/landing
    path("voice-call/", voice_call, name="voice_call"),             # simulated voice call
    path("api/ped/live", ped_live, name="ped_live"), 
    path("api/route/score", score_google_routes, name="route_score_api"),
    path("api/hazards/active/", hazards_active, name="hazards_active"),
    path("api/hazards/", hazards_create, name="hazards_create"),
 
]