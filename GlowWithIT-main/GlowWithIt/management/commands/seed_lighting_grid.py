
from django.core.management.base import BaseCommand
from django.core.management import call_command

def frange(start, stop, step):
    x = start
    # step can be negative if lat decreases southbound
    cmp = (lambda a, b: a <= b) if step > 0 else (lambda a, b: a >= b)
    while cmp(x, stop):
        yield x
        x = round(x + step, 6)

class Command(BaseCommand):
    
    help = "Seed lighting data by tiling a bbox into smaller cells and calling import_lighting for each."

    def add_arguments(self, parser):
        parser.add_argument("--n", type=float, required=True, help="north latitude")
        parser.add_argument("--s", type=float, required=True, help="south latitude")
        parser.add_argument("--e", type=float, required=True, help="east longitude")
        parser.add_argument("--w", type=float, required=True, help="west longitude")
        parser.add_argument("--lat_step", type=float, default=0.01, help="tile size in degrees latitude (~1.11 km)")
        parser.add_argument("--lon_step", type=float, default=0.015, help="tile size in degrees longitude near MEL (~1.3 km)")
        parser.add_argument("--timeout", type=int, default=180)
        parser.add_argument("--source", default="seed-grid")
        parser.add_argument("--retries", type=int, default=2)
        parser.add_argument("--backoff", type=float, default=2.0)

    def handle(self, *args, **opts):
        n, s, e, w = opts["n"], opts["s"], opts["e"], opts["w"]
        dlat = -abs(opts["lat_step"]) if s < n else abs(opts["lat_step"])
        dlon = abs(opts["lon_step"]) if e > w else -abs(opts["lon_step"])

        # iterate small tiles: (lat_top, lat_bottom, lon_right, lon_left)
        lat_edges = list(frange(n, s, dlat))
        lon_edges = list(frange(w, e, dlon))
        if len(lat_edges) < 2 or len(lon_edges) < 2:
            self.stdout.write(self.style.WARNING("Bbox too small for the chosen step."))
            return

        total = 0
        for i in range(len(lat_edges) - 1):
            top = lat_edges[i]
            bottom = lat_edges[i+1]
            north, south = (top, bottom) if top > bottom else (bottom, top)
            for j in range(len(lon_edges) - 1):
                left = lon_edges[j]
                right = lon_edges[j+1]
                west, east = (left, right) if left < right else (right, left)

                self.stdout.write(f"Tiling bbox N:{north} S:{south} E:{east} W:{west}")
                call_command(
                    "import_lighting",
                    "--bbox", str(north), str(south), str(east), str(west),
                    "--timeout", str(opts["timeout"]),
                    "--source", opts["source"],
                    "--retries", str(opts["retries"]),
                    "--backoff", str(opts["backoff"]),
                )
                total += 1

        self.stdout.write(self.style.SUCCESS(f"Seed complete. Tiles imported: {total}"))
