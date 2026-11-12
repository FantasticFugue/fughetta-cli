// Source synchronization and explicit branch management use REST, outside the agent's tool list.
import { call, responseError, type Connection } from "./remote.js";
import type { Binding } from "./checkout/binding.js";

export async function worldline(
    core: Connection,
    binding: Binding,
    action: string,
    parameters: Record<string, unknown> = {},
): Promise<unknown> {
    const reply = await call(
        core,
        "POST",
        `/api/v1/projects/${encodeURIComponent(binding.project)}/worldline`,
        { ...parameters, project: binding.project, worldline: binding.worldline, action },
    );
    if (reply.status !== 200) throw responseError(reply);
    return JSON.parse(reply.body);
}
