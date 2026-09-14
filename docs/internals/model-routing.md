# Model routing credential boundary

Model routing (the built-in proxy and the backend-connection settings) carries two
deliberately separate credential classes.

**API keys** (`ServerSettings.modelCredentials`) are routing-layer credentials:
vendor-scoped, reusable across any number of connections and provider instances,
and resolvable by both the harness env overlay and the router's upstream requests.

**OAuth and subscription tokens** are harness-bound. They live only in each
provider instance's own CLI configuration (`auth.json`, `CLAUDE_CONFIG_DIR`, …)
and are never copied into settings, the credential store, or the router. A
subscription model stays exclusive to its own CLI; serving it through another
harness — or through the router — requires an API key.

Both layers enforce this structurally: `ModelCredential` and
`ModelRouterRouteTarget` cannot express an OAuth token. A feature that wants
subscription models behind the router is a design change, not a schema value.

Routing is strict by decision: a route resolves to exactly one upstream, an
unknown model slug is a 404, an upstream failure relays the upstream error, and
there is no fallback or retry on another target. Silent rerouting would hide the
cost and capability differences between the model the thread selected and the
model that actually answered.

See [ModelRouterProxy](../../apps/server/src/provider/router/ModelRouterProxy.ts)
and [modelRouter.ts](../../packages/contracts/src/modelRouter.ts).
