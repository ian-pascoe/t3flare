// The workerd test Worker: the agents Worker's Durable Objects that need no Container or Worker Loader.
export { ContainerBudget } from "../src/budget.ts";

export default { fetch: () => new Response("t3flare agents test worker") };
