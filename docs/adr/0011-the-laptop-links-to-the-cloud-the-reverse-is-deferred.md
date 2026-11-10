# The laptop links to the cloud; the reverse is deferred

Orchestration between the laptop and the cloud uses t3's Peer links: the linking Environment signs in to the other's `/mcp`, and a delegated task runs there as an ordinary thread. Only the cloud is publicly reachable, so in v1 the laptop links to the cloud and laptop agents delegate to cloud agents. Clients attach to both Environments directly. Cloud-to-laptop links need the laptop reachable (T3 Connect or Tailscale) and are additive later. Moving a thread between Environments is out of scope; delegation covers most of the need.
