# nodejs-eks-starter — Agent Notes

## Status
- [x] Discovery (get_environment, probe_cloud)
- [x] Blueprint selected: nodejs-eks@1.4.0
- [x] Project meta approved
- [x] Design approved (architecture.d2 + pipeline.yaml from blueprint)
- [x] Plan approved
- [ ] Generation in progress
- [ ] validate_project
- [ ] create_repo_and_push
- [ ] deploy

## Blueprint Inheritance
- **Blueprint**: nodejs-eks@1.4.0 (official)
- **Params**: aws_region=us-east-1, app_replicas=2, db_instance_class=db.t4g.micro, node_desired_size=2, node_instance_type=t3.medium, kubernetes_version=1.33
- **Modules**: database=postgres
- apply_template(scope='design') — wrote architecture.d2 + pipeline.yaml (rev 1)
- apply_template(scope='files') — to materialise IaC/manifests/tooling files

## Architecture Decisions
- EKS 1.33 (STANDARD support as of 2026-07; 1.30–1.32 are extended-support only)
- RDS Postgres db.t4g.micro, single-AZ, encrypted, 7-day backups
- No NAT Gateway (blueprint design: public subnets for nodes, private for RDS)
- NLB fronts the Kubernetes LoadBalancer Service
- KMS key for EKS Secret envelope encryption
- Node.js 20 Alpine (multi-stage Docker image)

## Secret Contract
- DB_PASSWORD: alphanumeric ≥20 chars, set via set_pipeline_secret
- DATABASE_URL: built from RDS endpoint at configure time (terraform output → K8s secret)
- All secrets referenced as ${{ secrets.NAME }} — no literal values in files

## Pipeline Notes
- 7 parallel gates before ANY AWS resource is touched
- provision → build_push → image_scan → configure → verify → notify
- configure: re-inits terraform to read database_url output (self-sufficient job rule)
- destroy: custom sequence — delete K8s LB first, poll until gone, then terraform destroy

## Known Constraints
- RDS master user is NOT superuser — extensions requiring superuser won't install
- No NAT Gateway: node group runs in public subnets with public IPs (blueprint design)
- EKS add-ons (metrics-server) installed in configure stage via kubectl apply

## Cost Estimate
- EKS control plane: ~$72/mo
- 2x t3.medium nodes: ~$60/mo
- RDS db.t4g.micro: ~$12/mo
- ECR: minimal
- Total: ~$150–160/mo
