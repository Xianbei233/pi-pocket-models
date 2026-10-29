/**
 * One role table for every dispatch path in this Pocket install.
 *
 * The roles and their fixed models come from the owner's standing policy: PiP coordinates, the planner plans and never
 * writes code, development writes code, testing writes and runs tests. A module that dispatches work reads the model
 * from here instead of restating it, so a role cannot drift between the recipe runner, the fusion graph, and the role
 * policy that enforces it.
 *
 * This table is a default, not a gate. Enforcement lives in `pi-pocket-models`, which injects or refuses the model on
 * a subagent/team call from the owner's own policy document; this file only covers paths that dispatch through
 * `linkedSessions` (the recipe runner, the fusion graph). A role the owner did not name has no default here and keeps
 * whatever model the caller inherited.
 */

export interface RoleSpec {
    /** `provider/modelId`, the form Pocket accepts in a model choice. */
    readonly model: string;
    /** Pocket thinking level; undefined leaves the level to the child's own default. */
    readonly thinking?: string;
}

/** The owner's four standing roles. */
export const ROLES: Readonly<Record<string, RoleSpec>> = {
    pip: { model: "openai/gpt-6.1-sol", thinking: "medium" },
    planner: { model: "hww/gpt-6.1-sol", thinking: "max" },
    dev: { model: "opencode-go/deepseek-v4.1-flash" },
    test: { model: "hww/gpt-6.1-terra", thinking: "max" },
};

/** Spellings that mean the same role, including the owner's own words. */
const ALIASES: Readonly<Record<string, string>> = {
    pip: "pip",
    coordinator: "pip",
    planner: "planner",
    plan: "planner",
    planning: "planner",
    lead: "planner",
    主规划: "planner",
    规划: "planner",
    dev: "dev",
    developer: "dev",
    development: "dev",
    implementer: "dev",
    开发: "dev",
    test: "test",
    tests: "test",
    tester: "test",
    testing: "test",
    qa: "test",
    测试: "test",
};

/** `"provider/modelId"` for a name that matches a standing role, else "" (caller keeps its own model). */
export function roleModel(...names: (string | undefined)[]): string {
    return roleSpec(...names)?.model ?? "";
}

/** Pocket thinking level for a name that matches a standing role, else "" (caller keeps its own level). */
export function roleThinking(...names: (string | undefined)[]): string {
    return roleSpec(...names)?.thinking ?? "";
}

export function roleSpec(...names: (string | undefined)[]): RoleSpec | undefined {
    for (const name of names) {
        if (typeof name !== "string" || name.trim() === "") {
            continue;
        }
        const key = name.trim().toLowerCase();
        const canonical = ALIASES[key] ?? (key in ROLES ? key : undefined);
        if (canonical !== undefined) {
            return ROLES[canonical];
        }
    }
    return undefined;
}
