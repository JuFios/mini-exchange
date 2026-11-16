import datetime
import json
import pathlib
import sys


reports = pathlib.Path(sys.argv[1])
policy = pathlib.Path(__file__).with_name("image-audit-exceptions.json")
exceptions = json.loads(policy.read_text())
today = datetime.datetime.now(datetime.timezone.utc).date()
failed = False
for service in ("matching-engine-1", "settlement-service", "frontend", "engine-lb"):
    report = json.loads((reports / f"{service}.json").read_text())
    results = report["Results"]
    if not results or report["ArtifactType"] != "container_image":
        raise ValueError(f"Missing runtime image findings for {service}")
    findings = {
        (row["PkgName"], row["InstalledVersion"], row["VulnerabilityID"])
        for result in results
        for row in result.get("Vulnerabilities", [])
        if row["Severity"] in ("HIGH", "CRITICAL")
    }
    accepted = {
        (item["package"], item["version"], advisory)
        for item in exceptions.get(service, [])
        if today <= datetime.date.fromisoformat(item["expires"])
        for advisory in item["advisories"]
    }
    print(json.dumps({"service": service, "high_or_critical": len(findings),
                      "unaccepted": sorted(findings - accepted)}))
    failed |= not findings <= accepted
sys.exit(1 if failed else 0)
