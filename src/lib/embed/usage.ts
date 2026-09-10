import { prisma } from "@/lib/prisma";

/**
 * ============================================================================
 *  METERING
 * ============================================================================
 *  Charged per active tenant, so usage has to be attributable to a tenant and
 *  tenants have to be countable.
 *
 *  THE METER COUNTS PROVIDER CALLS, NOT HTTP REQUESTS.
 *
 *  They diverge, and the divergence is the interesting part:
 *
 *    - a knowledge question that takes the pre-router's fast path skips
 *      planning entirely — one call, not two;
 *    - a question that needs three repair rounds costs four;
 *    - a question served from cache costs none.
 *
 *  Counting requests would hide all of that, and would make the caching work
 *  invisible rather than visible as a saving on the invoice.
 *
 *  CREDITS FOLLOW THE DATA, NOT THE ASKER.
 *
 *  A question spends the credits of the tenant whose data it READ, whoever was
 *  at the keyboard. Head office querying Store B spends Store B's credits, not
 *  the organization's and not Store A's. That is what makes a per-tenant usage
 *  line mean something exact — "what was read from this store" — rather than
 *  "what people who work at this store happened to ask".
 *
 *  It also costs nothing to enforce, because cross-tenant access is switching
 *  rather than blending (see lib/embed/access.ts): one question reads exactly
 *  one tenant, so there is never an ambiguous call to split and no
 *  discriminator column is needed. The tenant that was queried is the tenant
 *  that pays, and there is exactly one of them.
 *
 *  The same reasoning covers keys: an integrator who consolidates 4,000 tenant
 *  keys into one org key has changed their credential management, not what was
 *  read, so their invoice does not move.
 * ============================================================================
 */

export interface UsageDelta {
  questions?: number;
  providerCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
  refusals?: number;
}

/** "2026-09" in UTC. The bucket boundary has to be one thing everywhere. */
export function billingPeriod(at: Date = new Date()): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Add to a tenant's counters for the current period.
 *
 * Never throws. A metering write that fails must not fail the answer the user
 * was waiting for — the invoice being slightly light is a far smaller problem
 * than a question dying because a bookkeeping row was locked. Failures are
 * logged so a persistent one is visible rather than silent.
 */
export async function recordUsage(
  organizationId: string,
  tenantId: string,
  delta: UsageDelta,
  at: Date = new Date()
): Promise<void> {
  const period = billingPeriod(at);
  const inc = {
    questions: delta.questions ?? 0,
    providerCalls: delta.providerCalls ?? 0,
    inputTokens: delta.inputTokens ?? 0,
    outputTokens: delta.outputTokens ?? 0,
    refusals: delta.refusals ?? 0,
  };
  if (Object.values(inc).every((n) => n === 0)) return;

  try {
    await prisma.usageRecord.upsert({
      where: { tenantId_period: { tenantId, period } },
      update: {
        questions: { increment: inc.questions },
        providerCalls: { increment: inc.providerCalls },
        inputTokens: { increment: inc.inputTokens },
        outputTokens: { increment: inc.outputTokens },
        refusals: { increment: inc.refusals },
      },
      create: { organizationId, tenantId, period, ...inc },
    });
  } catch (error) {
    console.error("usage: failed to record", { tenantId, period, error });
  }
}

export interface TenantUsage {
  tenantId: string;
  externalKey: string;
  label: string;
  status: string;
  questions: number;
  providerCalls: number;
  inputTokens: number;
  outputTokens: number;
  refusals: number;
  /** Provider calls included this period. Null = uncapped. */
  allowance: number | null;
  /** Calls past the allowance. Billed, never refused — see below. */
  overage: number;
}

export interface UsageSummary {
  period: string;
  /** What the headline charge is based on. */
  billableTenants: number;
  totals: {
    questions: number;
    providerCalls: number;
    inputTokens: number;
    outputTokens: number;
    refusals: number;
    overage: number;
  };
  /** Tenants currently past their allowance — what a billing screen leads with. */
  tenantsOverAllowance: number;
  tenants: TenantUsage[];
}

/**
 * One period's usage across an organization.
 *
 * Tenants with no rows are still listed at zero. A tenant that is ACTIVE and
 * silent is still billable — the charge is for the seat, not the questions —
 * and an invoice that omits it invites an argument later.
 */
export async function usageForPeriod(
  organizationId: string,
  period: string = billingPeriod()
): Promise<UsageSummary> {
  const [tenants, records] = await Promise.all([
    prisma.tenant.findMany({
      where: { organizationId },
      select: {
        id: true,
        externalKey: true,
        label: true,
        status: true,
        creditAllowance: true,
      },
      orderBy: { externalKey: "asc" },
    }),
    prisma.usageRecord.findMany({ where: { organizationId, period } }),
  ]);

  const byTenant = new Map(records.map((r) => [r.tenantId, r]));

  const rows: TenantUsage[] = tenants.map((t) => {
    const r = byTenant.get(t.id);
    const providerCalls = r?.providerCalls ?? 0;
    const allowance = t.creditAllowance ?? null;
    return {
      tenantId: t.id,
      externalKey: t.externalKey,
      label: t.label,
      status: t.status,
      questions: r?.questions ?? 0,
      providerCalls,
      inputTokens: r?.inputTokens ?? 0,
      outputTokens: r?.outputTokens ?? 0,
      refusals: r?.refusals ?? 0,
      allowance,
      // Carried alongside the count, not enforced against it. Answers keep
      // flowing past the line — an end user mid-support-call is the wrong
      // person to punish for their supplier's billing arrangement — so the
      // whole obligation lands on making the overage VISIBLE from the first
      // call past the allowance rather than at month end.
      overage: allowance === null ? 0 : Math.max(0, providerCalls - allowance),
    };
  });

  const totals = rows.reduce(
    (acc, r) => ({
      questions: acc.questions + r.questions,
      providerCalls: acc.providerCalls + r.providerCalls,
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
      refusals: acc.refusals + r.refusals,
      overage: acc.overage + r.overage,
    }),
    {
      questions: 0,
      providerCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      refusals: 0,
      overage: 0,
    }
  );

  return {
    period,
    // Counted at read time from current status. The design says a tenant is
    // billable while ACTIVE, counted at period end; until a period is closed
    // this is the running figure.
    billableTenants: tenants.filter((t) => t.status === "ACTIVE").length,
    tenantsOverAllowance: rows.filter((r) => r.overage > 0).length,
    totals,
    tenants: rows,
  };
}

/* -------------------------------------------------------------------------- */
/* Retention                                                                  */
/* -------------------------------------------------------------------------- */

export interface SweepResult {
  tenantsConsidered: number;
  sessionsDeleted: number;
  embedSessionsDeleted: number;
}

/**
 * Delete conversations past their tenant's retention window, and expired embed
 * sessions along with them.
 *
 * This ships with the feature rather than after it. Retro-fitting deletion onto
 * data you already hold is the expensive order to do it in, and an integrator
 * whose regulator asks "how long do you keep it" needs an answer that is a
 * setting rather than an intention.
 *
 * Safe to run repeatedly and safe to run concurrently: it deletes by predicate,
 * so a second run simply finds nothing.
 */
export async function sweepRetention(
  organizationId?: string
): Promise<SweepResult> {
  const tenants = await prisma.tenant.findMany({
    where: {
      ...(organizationId ? { organizationId } : {}),
      retentionDays: { not: null },
    },
    select: { id: true, retentionDays: true },
  });

  let sessionsDeleted = 0;
  for (const tenant of tenants) {
    const days = tenant.retentionDays ?? 0;
    if (days <= 0) continue;
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const { count } = await prisma.chatSession.deleteMany({
      // updatedAt, not createdAt: a conversation someone is still using has not
      // been dormant for the retention window, whatever its age.
      where: { tenantId: tenant.id, updatedAt: { lt: cutoff } },
    });
    sessionsDeleted += count;
  }

  // Expired tokens are not credentials any more, but they are still rows that
  // name an end user. There is no reason to keep them past a grace period.
  const { count: embedSessionsDeleted } = await prisma.embedSession.deleteMany({
    where: {
      ...(organizationId ? { organizationId } : {}),
      expiresAt: { lt: new Date(Date.now() - 7 * 86_400_000) },
    },
  });

  return {
    tenantsConsidered: tenants.length,
    sessionsDeleted,
    embedSessionsDeleted,
  };
}
