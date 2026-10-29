/**
 * Pi Pocket Models: one table for who runs on what.
 *
 * Before this module the same decision lived in five places: a prose table in AGENTS.md, the ROLES table in
 * _dispatch.ts, the owner's role-policy document, Pocket's subagentModels allow-list, and each recipe's own role
 * fields. They drifted, and a dispatch failed on a model that four of the five agreed on. This module is the one table:
 *
 * 1. Roles. pip, planner, dev, test, each with one model and one thinking level. A subagent or team dispatch is
 *    rewritten to that model before it leaves the conversation, so the model never has to remember the table.
 * 2. Refusals. A dispatch that names a model or thinking level absent from the table is refused with the table spelled
 *    out. Nothing is clamped and nothing falls back: the Owner changes the table, not the call.
 * 3. Drift. The allow-list (subagentModels) and the two config files are read and compared, never written. Pocket's
 *    Host API has no settings writer, so the report names the exact model ids that must be added and the Owner applies
 *    them. A missing allow-list entry is refused at dispatch time with the same list.
 *
 * The table lives in a session-scope Durable document, so this module keeps no state in memory and needs no restart.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { ROLES as DISPATCH_ROLES } from "./_dispatch.ts";
import { defineDoc, defineExtension, defineTool, wrapTool } from "@earendil-works/pi-durable";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type RoleEntry = { model: string; thinking: string; title: string };

export type ModelPolicy = {
    version: number;
    defaultRole: string;
    roles: Record<string, RoleEntry>;
};

type Host = {
    readonly dataDir: string;
    readonly agentDir: string;
    subagentModels(): readonly string[];
    modelInfo(spec: string): { name: string; thinkingLevels: readonly string[] } | undefined;
    notice(level: "info" | "warning" | "error", message: string): void;
};

/** Spellings that mean the same role, including the Owner's own words and the names recipes use. */
const ALIASES: Readonly<Record<string, string>> = {
    pip: "pip",
    coordinator: "pip",
    "协调": "pip",
    planner: "planner",
    plan: "planner",
    planning: "planner",
    lead: "planner",
    "主规划": "planner",
    "规划": "planner",
    dev: "dev",
    developer: "dev",
    development: "dev",
    implementer: "dev",
    "开发": "dev",
    test: "test",
    tests: "test",
    tester: "test",
    testing: "test",
    qa: "test",
    "测试": "test",
};

export function emptyPolicy(): ModelPolicy {
    return {
        version: 1,
        defaultRole: "planner",
        roles: {
            pip: { model: "openai/gpt-6.1-sol", thinking: "medium", title: "PiP" },
            planner: { model: "hww/gpt-6-astra", thinking: "low", title: "主规划" },
            dev: { model: "opencode-go/deepseek-v4.1-flash", thinking: "", title: "开发" },
            test: { model: "hww/gpt-6.1-terra", thinking: "max", title: "测试" },
        },
    };
}

export function normalizeName(value: string): string {
    return value.trim().toLowerCase().replace(/\s+/gu, "");
}

export function roleKeyFor(policy: ModelPolicy, name: string): string | undefined {
    const key = normalizeName(name);

    if (key === "") {
        return undefined;
    }

    if (policy.roles[key] !== undefined) {
        return key;
    }

    const alias = ALIASES[key];

    if (alias !== undefined && policy.roles[alias] !== undefined) {
        return alias;
    }

    return undefined;
}

export function parseModel(spec: string): { provider: string; modelId: string } | undefined {
    const parts = spec.split("/");

    if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
        return undefined;
    }

    return { provider: parts[0] as string, modelId: parts[1] as string };
}

export type DispatchInput = {
    readonly action?: string;
    readonly name?: string;
    readonly agent?: string;
    readonly role?: string;
    readonly model?: string;
    readonly thinking?: string;
};

export type Catalog = { info(spec: string): { thinkingLevels: readonly string[] } | undefined };

export type DispatchDecision =
    | { readonly ok: true; readonly role: string; readonly model: string; readonly thinking: string }
    | { readonly ok: false; readonly reason: string };

export function tableText(policy: ModelPolicy): string {
    return Object.entries(policy.roles)
        .map(([key, entry]) => {
            const level = entry.thinking === "" ? "不指定档位" : entry.thinking;

            return entry.title + "(" + key + ") = " + entry.model + " / " + level;
        })
        .join("；");
}

export function missingFromAllowlist(policy: ModelPolicy, allowed: readonly string[]): string[] {
    const missing: string[] = [];

    for (const entry of Object.values(policy.roles)) {
        if (!allowed.includes(entry.model) && !missing.includes(entry.model)) {
            missing.push(entry.model);
        }
    }

    return missing;
}

export function decideDispatch(
    policy: ModelPolicy,
    allowed: readonly string[],
    input: DispatchInput,
    catalog: Catalog,
): DispatchDecision {
    const named = input.name ?? input.agent ?? input.role ?? "";
    const key = named === "" ? policy.defaultRole : roleKeyFor(policy, named);
    const entry = key === undefined ? undefined : policy.roles[key];

    if (key === undefined || entry === undefined) {
        return {
            ok: false,
            reason:
                "模型表里没有角色 " + JSON.stringify(named) + "。现在的表：" + tableText(policy) +
                "。要么把角色名改成表里的名字，要么让 Owner 改表；不要自己选模型。",
        };
    }

    if (parseModel(entry.model) === undefined) {
        return { ok: false, reason: "模型表里 " + key + " 的 " + entry.model + " 不是 provider/modelId 形式。" };
    }

    const requestedModel = input.model === undefined ? "" : String(input.model).trim();

    if (requestedModel !== "" && requestedModel !== entry.model) {
        return {
            ok: false,
            reason:
                "派发请求里的模型 " + requestedModel + " 和表里 " + key + " 的 " + entry.model + " 不一致。" +
                "这一层不降档也不替换：要换模型就让 Owner 调 model_policy_set。表：" + tableText(policy) + "。",
        };
    }

    const requestedThinking = input.thinking === undefined ? "" : String(input.thinking).trim();

    if (requestedThinking !== "" && entry.thinking !== "" && requestedThinking !== entry.thinking) {
        return {
            ok: false,
            reason:
                "派发请求里的档位 " + requestedThinking + " 和表里 " + key + " 的 " + entry.thinking + " 不一致。" +
                "档位写在表里，不在调用里。表：" + tableText(policy) + "。",
        };
    }

    const info = catalog.info(entry.model);

    if (info === undefined) {
        return { ok: false, reason: "模型目录里没有 " + entry.model + "，这一层不会猜一个近似的型号。" };
    }

    if (entry.thinking !== "" && !info.thinkingLevels.includes(entry.thinking)) {
        return {
            ok: false,
            reason:
                entry.model + " 不支持档位 " + entry.thinking + "（支持 " + info.thinkingLevels.join(", ") +
                "）。表里写错了，改表，不要指望宿主截低。",
        };
    }

    if (!allowed.includes(entry.model)) {
        return {
            ok: false,
            reason:
                "子代理白名单里没有 " + entry.model + "，派发还没开始就会被 Pocket 拦住。需要 Owner 把它加进 " +
                "subagentModels（本插件只检测、不写配置）。当前缺少：" + missingFromAllowlist(policy, allowed).join(", ") + "。",
        };
    }

    return { ok: true, role: key, model: entry.model, thinking: entry.thinking };
}

export type PocketConfig = {
    readonly defaultModel?: { provider?: string; modelId?: string; thinkingLevel?: string };
    readonly lastModel?: { provider?: string; modelId?: string; thinkingLevel?: string };
    readonly subagentModels?: readonly string[];
};

export type DesktopSettings = {
    readonly defaultProvider?: string;
    readonly defaultModel?: string;
    readonly enabledModels?: readonly string[];
};

function describeChoice(choice: PocketConfig["defaultModel"]): string {
    if (choice === undefined || choice.modelId === undefined) {
        return "未设置";
    }

    return String(choice.provider) + "/" + String(choice.modelId) + " " + String(choice.thinkingLevel ?? "未指定档位");
}

export function driftLines(
    policy: ModelPolicy,
    allowed: readonly string[],
    pocket: PocketConfig | undefined,
    desktop: DesktopSettings | undefined,
): string[] {
    const lines: string[] = [];
    const missing = missingFromAllowlist(policy, allowed);

    if (missing.length === 0) {
        lines.push("白名单：表里 " + Object.keys(policy.roles).length + " 个角色的模型都在 subagentModels 里。");
    } else {
        lines.push("白名单缺 " + String(missing.length) + " 条：" + missing.join(", ") + " —— 这些角色派发会被 Pocket 直接拦。");
    }

    if (pocket !== undefined) {
        const declared = pocket.subagentModels ?? [];

        for (const model of declared) {
            if (!Object.values(policy.roles).some((entry) => entry.model === model)) {
                lines.push("白名单里有表外的模型 " + model + "（不冲突，只是多出来的额度）。");
            }
        }

        lines.push("pocket 默认会话模型：" + describeChoice(pocket.defaultModel) + "（新会话起手，不归角色表管）。");
        lines.push("pocket 最后选过的模型：" + describeChoice(pocket.lastModel) + "（defaultModel 非空时不生效）。");
    }

    for (const [key, entry] of Object.entries(policy.roles)) {
        const mirrored = (DISPATCH_ROLES as Record<string, { model?: string } | undefined>)[key];

        if (mirrored !== undefined && mirrored.model !== undefined && mirrored.model !== entry.model) {
            lines.push(
                "_dispatch.ts 里 " + key + " 还是 " + mirrored.model + "，表里是 " + entry.model +
                    "（配方派发走 linkedSessions，只认 _dispatch，不经过本插件）。",
            );
        }
    }

    if (desktop !== undefined) {
        const enabled = desktop.enabledModels ?? [];
        const absent = Object.values(policy.roles)
            .map((entry) => entry.model)
            .filter((model, index, all) => all.indexOf(model) === index && !enabled.includes(model));

        lines.push(
            "桌面 settings.json 默认 " + String(desktop.defaultProvider ?? "?") + "/" + String(desktop.defaultModel ?? "?") +
                "，可选 " + String(enabled.length) + " 条" +
                (absent.length === 0 ? "，表里的模型都在可选集里。" : "，表里的 " + absent.join(", ") + " 不在可选集里（桌面那边本插件改不到）。"),
        );
    }

    return lines;
}

const PolicyDoc = defineDoc<ModelPolicy>({
    kind: "x.pi-pocket-models.policy",
    version: 1,
    scope: "session",
    history: "latest",
    fork: "initial",
    initial: emptyPolicy,
});

export default function createModels(host: Host) {
    const copyOf = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
    const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });

    const catalog: Catalog = {
        info: (spec) => {
            const info = host.modelInfo(spec);

            return info === undefined ? undefined : { thinkingLevels: info.thinkingLevels };
        },
    };

    const readPolicy = async (api: any, context: any): Promise<ModelPolicy> =>
        ((await api.snapshot(PolicyDoc, undefined, context)) ?? emptyPolicy()) as ModelPolicy;

    const readJson = async (path: string): Promise<any> => {
        try {
            return JSON.parse(await readFile(path, "utf8")) as unknown;
        } catch {
            return undefined;
        }
    };

    const show = defineTool({
        name: "model_policy",
        description:
            "Show the one model table (pip/planner/dev/test -> model + thinking), the subagent allow-list gap, and " +
            "the drift against pocket and desktop config. Read-only: it never changes a setting.",
        parameters: Type.Object({}),
        execute: async (_args: unknown, api: any, context: any) => {
            const policy = await readPolicy(api, context);
            const allowed = host.subagentModels();
            const pocket = (await readJson(join(host.dataDir, "config.json"))) as PocketConfig | undefined;
            const desktop = (await readJson(join(host.agentDir, "settings.json"))) as DesktopSettings | undefined;
            const rows = Object.entries(policy.roles).map(
                ([key, entry], index) =>
                    String(index + 1) + ". " + entry.title + " (" + key + ")：模型 " + entry.model +
                    "，档位 " + (entry.thinking === "" ? "不指定" : entry.thinking),
            );
            const lines = [
                "模型表（唯一来源，默认角色 " + policy.defaultRole + "）：",
                ...rows,
                "",
                ...driftLines(policy, allowed, pocket, desktop),
            ];

            return reply(lines.join("\n"));
        },
    });

    const setRole = defineTool({
        name: "model_policy_set",
        description:
            "Change one role's model or thinking in the single table. Validates against the model catalog; it never " +
            "writes pocket config, so a model missing from the subagent allow-list is reported, not added.",
        parameters: Type.Object({
            role: Type.String({ description: "Role key or alias: pip, planner, dev, test, 主规划, 开发, 测试." }),
            model: Type.String({ description: "provider/modelId, for example hww/gpt-6.1-terra." }),
            thinking: Type.Optional(
                Type.String({ description: "off, minimal, low, medium, high, xhigh, max. Empty leaves it unspecified." }),
            ),
        }),
        execute: async (args: any, api: any, context: any) => {
            const policy = await readPolicy(api, context);
            const key = roleKeyFor(policy, String(args?.role ?? ""));

            if (key === undefined) {
                return reply("没有这个角色：" + String(args?.role ?? "") + "。表里只有 " + Object.keys(policy.roles).join(", ") + "。");
            }

            const model = String(args?.model ?? "").trim();
            const thinking = args?.thinking === undefined ? (policy.roles[key] as RoleEntry).thinking : String(args.thinking).trim();

            if (parseModel(model) === undefined) {
                return reply(model + " 不是 provider/modelId 形式。");
            }

            const info = host.modelInfo(model);

            if (info === undefined) {
                return reply("模型目录里没有 " + model + "，不写进去。");
            }

            if (thinking !== "" && !info.thinkingLevels.includes(thinking)) {
                return reply(model + " 不支持档位 " + thinking + "（支持 " + info.thinkingLevels.join(", ") + "）。");
            }

            await api.commit(async (tx: any) => {
                const current = (await tx.doc(PolicyDoc)) ?? emptyPolicy();
                const next = copyOf(current);
                next.roles[key] = { ...next.roles[key], model, thinking } as RoleEntry;
                Object.assign(current, next);

                return copyOf(next);
            }, context);

            const allowed = host.subagentModels();
            const note = allowed.includes(model)
                ? "白名单里已有这个模型。"
                : "注意：subagentModels 里还没有 " + model + "，派发会被 Pocket 拦住，需要 Owner 加进去。";

            return reply("已更新 " + key + " → " + model + " / " + (thinking === "" ? "不指定档位" : thinking) + "。" + note);
        },
    });

    const subagentProbe = defineTool({
        name: "subagent",
        description: "Persistent subagents.",
        parameters: Type.Object({}, { additionalProperties: true }),
        execute: async () => ({}),
    });

    const teamProbe = defineTool({
        name: "team",
        description: "Linked sessions.",
        parameters: Type.Object({}, { additionalProperties: true }),
        execute: async () => ({}),
    });

    const wrapDispatch = (probe: typeof subagentProbe, dispatchAction: string) =>
        wrapTool(probe, (tool: any) => ({
            ...tool,
            execute: async (args: any, api: any, context: any) => {
                const action = typeof args?.action === "string" ? args.action : "";

                // Listing, status, and stop actions launch no model, so they pass through untouched.
                if (action !== dispatchAction) {
                    return tool.execute(args, api, context);
                }

                const policy = await readPolicy(api, context);
                const decision = decideDispatch(policy, host.subagentModels(), (args ?? {}) as DispatchInput, catalog);

                if (!decision.ok) {
                    return reply(decision.reason);
                }

                return tool.execute(
                    {
                        ...args,
                        model: decision.model,
                        ...(decision.thinking === "" ? { thinking: undefined } : { thinking: decision.thinking }),
                    },
                    api,
                    context,
                );
            },
        }));

    return defineExtension({
        name: "pi-pocket-models",
        tools: [show, setRole],
        wraps: [wrapDispatch(subagentProbe, "spawn"), wrapDispatch(teamProbe, "start")],
    });
}
