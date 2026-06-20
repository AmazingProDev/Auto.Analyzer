import time
def _hav(lat1, lon1, lat2, lon2):
    from math import radians, sin, cos, asin
    R = 6_371_000.0
    lat1, lon1, lat2, lon2 = map(radians, [lat1, lon1, lat2, lon2])
    a = sin((lat2 - lat1) / 2) ** 2 + cos(lat1) * cos(lat2) * sin((lon2 - lon1) / 2) ** 2
    return R * 2.0 * asin(max(0.0, min(1.0, a)) ** 0.5)

t0 = time.time()
for _ in range(500000):
    _hav(33.9, -6.8, 33.91, -6.81)
print("500k haversine:", time.time() - t0)
