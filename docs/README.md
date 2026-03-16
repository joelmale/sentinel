# Sentinel Docs

This directory contains technical documentation for Sentinel's runtime architecture, data model, ingest pipeline, API connectivity, and frontend state flow.

Recommended reading order:

1. [Architecture Overview](/Users/JoelN/Coding/sentinel/docs/architecture/01_system_overview.md)
2. [Data Model](/Users/JoelN/Coding/sentinel/docs/architecture/03_data_model.md)
3. [Identity And Current State](/Users/JoelN/Coding/sentinel/docs/architecture/04_identity_and_current_state.md)
4. [Collector Pipeline](/Users/JoelN/Coding/sentinel/docs/architecture/05_collector_pipeline.md)
5. [API And WebSocket Contracts](/Users/JoelN/Coding/sentinel/docs/architecture/07_api_and_websocket_contracts.md)
6. [Frontend State And Data Flow](/Users/JoelN/Coding/sentinel/docs/architecture/08_frontend_state_and_data_flow.md)
7. [Operational Workflows](/Users/JoelN/Coding/sentinel/docs/architecture/09_operational_workflows.md)

Primary audience:

- developers extending collectors, routes, or UI surfaces
- operators diagnosing ingest/runtime issues
- maintainers working on data-model or state-flow changes

Architecture set:

- [System Overview](/Users/JoelN/Coding/sentinel/docs/architecture/01_system_overview.md)
- [Runtime Components](/Users/JoelN/Coding/sentinel/docs/architecture/02_runtime_components.md)
- [Data Model](/Users/JoelN/Coding/sentinel/docs/architecture/03_data_model.md)
- [Identity And Current State](/Users/JoelN/Coding/sentinel/docs/architecture/04_identity_and_current_state.md)
- [Collector Pipeline](/Users/JoelN/Coding/sentinel/docs/architecture/05_collector_pipeline.md)
- [Domain Data Flows](/Users/JoelN/Coding/sentinel/docs/architecture/06_domain_data_flows.md)
- [API And WebSocket Contracts](/Users/JoelN/Coding/sentinel/docs/architecture/07_api_and_websocket_contracts.md)
- [Frontend State And Data Flow](/Users/JoelN/Coding/sentinel/docs/architecture/08_frontend_state_and_data_flow.md)
- [Operational Workflows](/Users/JoelN/Coding/sentinel/docs/architecture/09_operational_workflows.md)
- [Configuration And Integrations](/Users/JoelN/Coding/sentinel/docs/architecture/10_configuration_and_integrations.md)
- [Known Gaps And Transitional Compromises](/Users/JoelN/Coding/sentinel/docs/architecture/11_known_gaps_and_transitional_compromises.md)

Appendices:

- [Table Catalog](/Users/JoelN/Coding/sentinel/docs/architecture/appendix_table_catalog.md)
- [Route Catalog](/Users/JoelN/Coding/sentinel/docs/architecture/appendix_route_catalog.md)
- [Store Catalog](/Users/JoelN/Coding/sentinel/docs/architecture/appendix_store_catalog.md)

Implementation note:

- These docs describe the current codebase first.
- Where the implementation is transitional, the docs call that out explicitly.
- Existing planning docs under `docs/` remain useful for future work, but the `docs/architecture/` set is intended to describe the running system.
