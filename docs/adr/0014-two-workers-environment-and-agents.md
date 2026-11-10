# Two Workers: environment and agents

The `environment` Worker holds the front door, the Environment DO and the t3 web client's assets. The `agents` Worker holds the Session DOs, Workspace DOs and the Container binding. Durable Objects of one Worker can share an isolate and its 128 MB, and a Session waking should not pay t3's startup cost (the 1 s startup limit is t3's to spend). The two Workers also deploy differently: Sessions survive resets by design and use the default deferred update, while the environment Worker waits up to about 30 minutes (ADR-0004).
