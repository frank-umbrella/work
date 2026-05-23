"""
probes — one module per data source. Every probe exposes:

    def collect() -> dict | None

Returning None means "not applicable on this host" (e.g. Veeam isn't
installed). Returning a dict with an "_error" key means the probe tried
and failed — we surface that in the dashboard so a half-working probe
doesn't silently leave a hole in the report.

Probes must NEVER raise. The collector catches anyway as a safety net,
but each probe should wrap its real work in a try/except.
"""
