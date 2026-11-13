"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { type Account, type AccountList, errorMessage, formatFullDate, maskLast4, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { type Identifier, type PayeeRule, type Sample, ruleText, trimSampleText } from "@/lib/review";
import type { CategoryList } from "@/lib/transactions";
import { ConfirmDelete, LIST, Notice, ROW_ACTION, SECTION_TITLE, isUnauthorized } from "@/components/investments/shared";
import { PageHeader, Segmented, buttonClass } from "@/components/ui/chunky";
import { EmptyState } from "@/components/ui/empty-state";
import { ComboBox, Select } from "@/components/ui/select";

type Data = {
  rules: PayeeRule[];
  identifiers: Identifier[];
  samples: Sample[];
  accounts: Account[];
  categories: string[];
};
type Load = { status: "loading" } | { status: "error" } | { status: "ready"; data: Data };
type Deleting = { kind: "rule"; rule: PayeeRule } | { kind: "identifier"; identifier: Identifier } | null;

const ROW = "flex flex-wrap items-center gap-x-4 gap-y-2 px-3.5 py-2.5";
const EMPTY = "rounded-[18px] border-[2.5px] border-dashed border-ink bg-card px-3.5 py-3 text-sm font-bold text-zinc-600";
const ERROR = "mt-1 text-xs font-extrabold text-loss";
const SMALL_GREEN = `${buttonClass("green")} !px-3 !py-1 uppercase`;

// What the To review answers taught: payee rules, card and account numbers, and the messages the
// phone couldn't read, masked, so a parser can be written for them.
export function PayeeRulesView() {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<Deleting>(null);
  const latest = useRef(0);

  const fetchAll = useCallback(() => {
    const request = ++latest.current;
    Promise.all([
      apiFetch<{ rules: PayeeRule[] }>("/payee-rules"),
      apiFetch<{ identifiers: Identifier[] }>("/sms/identifiers"),
      apiFetch<{ samples: Sample[] }>("/sms/samples"),
      apiFetch<AccountList>("/accounts"),
      apiFetch<CategoryList>("/transactions/categories"),
    ])
      .then(([rules, identifiers, samples, accounts, categories]) => {
        if (request !== latest.current) return;
        setLoad({
          status: "ready",
          data: {
            rules: rules.rules,
            identifiers: identifiers.identifiers,
            samples: samples.samples,
            accounts: accounts.accounts,
            categories: [...new Set([...categories.expense, ...categories.income])],
          },
        });
      })
      .catch((err: unknown) => {
        if (isUnauthorized(err)) void logout();
        else if (request === latest.current) setLoad((l) => (l.status === "ready" ? l : { status: "error" }));
      });
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const saved = (rule: PayeeRule) => {
    setEditing(null);
    setNotice(null);
    setLoad((l) =>
      l.status === "ready"
        ? { status: "ready", data: { ...l.data, rules: l.data.rules.map((r) => (r.id === rule.id ? rule : r)) } }
        : l,
    );
  };

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Payee rules"
        action={
          <Link href="/review" className={`${buttonClass("alt")} uppercase`}>
            ‹ To review
          </Link>
        }
      />
      <Notice message={notice} />

      {load.status === "loading" && (
        <p role="status" className="text-sm font-bold text-zinc-600">
          Loading your rules...
        </p>
      )}

      {load.status === "error" && (
        <div role="alert" className="rounded-[18px] border-[2.5px] border-ink bg-card p-5 shadow-chunky">
          <p className="font-extrabold">We couldn&apos;t load your rules.</p>
          <button
            type="button"
            className={`mt-3 ${buttonClass("alt")} uppercase`}
            onClick={() => {
              setLoad({ status: "loading" });
              fetchAll();
            }}
          >
            Try again
          </button>
        </div>
      )}

      {load.status === "ready" && (
        <div className="flex flex-col gap-8">
          <section aria-labelledby="rules-title">
            <h2 id="rules-title" className={SECTION_TITLE}>
              Rules
            </h2>
            <p className="mb-2 px-1 text-xs font-bold text-zinc-600">
              New messages from these payees are sorted by themselves.
            </p>
            {load.data.rules.length === 0 ? (
              <EmptyState
                emoji="🪄"
                title="No rules yet"
                heading="h3"
                action={
                  <Link href="/review" className={`${buttonClass("primary")} uppercase`}>
                    Open To review
                  </Link>
                }
              >
                When you answer a bank message in To review, tick &quot;Always use this&quot;. Next time that payee is sorted for you.
              </EmptyState>
            ) : (
              <ul className={LIST}>
                {load.data.rules.map((rule) =>
                  editing === rule.id ? (
                    <li key={rule.id}>
                      <RuleForm
                        rule={rule}
                        accounts={load.data.accounts}
                        categories={load.data.categories}
                        onCancel={() => setEditing(null)}
                        onSaved={saved}
                        onStale={(message) => {
                          setEditing(null);
                          setNotice(message);
                          fetchAll();
                        }}
                      />
                    </li>
                  ) : (
                    <li key={rule.id} className={ROW}>
                      <div className="min-w-32 flex-1">
                        <p className="text-sm font-extrabold [overflow-wrap:anywhere]">{rule.display}</p>
                        <p className="text-xs font-bold text-zinc-600 [overflow-wrap:anywhere]">{ruleText(rule)}</p>
                      </div>
                      <div className="flex shrink-0 gap-1.5">
                        <button
                          type="button"
                          className={ROW_ACTION}
                          aria-label={`Edit the rule for ${rule.display}`}
                          onClick={() => setEditing(rule.id)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className={ROW_ACTION}
                          aria-label={`Delete the rule for ${rule.display}`}
                          onClick={() => setDeleting({ kind: "rule", rule })}
                        >
                          Delete
                        </button>
                      </div>
                    </li>
                  ),
                )}
              </ul>
            )}
          </section>

          <section aria-labelledby="numbers-title">
            <h2 id="numbers-title" className={SECTION_TITLE}>
              Account numbers
            </h2>
            <p className="mb-2 px-1 text-xs font-bold text-zinc-600">
              Card and account numbers you matched to an account, besides the one saved on the account itself.
            </p>
            {load.data.identifiers.length === 0 ? (
              <p className={EMPTY}>None yet. They&apos;re added when you match a card or account number to an account in To review.</p>
            ) : (
              <ul className={LIST}>
                {load.data.identifiers.map((identifier) => (
                  <li key={identifier.id} className={ROW}>
                    <p className="min-w-32 flex-1 text-sm font-extrabold [overflow-wrap:anywhere]">
                      {identifier.account_name}{" "}
                      <span className="font-bold whitespace-nowrap text-zinc-600">{maskLast4(identifier.last4)}</span>
                    </p>
                    <button
                      type="button"
                      className={ROW_ACTION}
                      aria-label={`Delete ${maskLast4(identifier.last4)} for ${identifier.account_name}`}
                      onClick={() => setDeleting({ kind: "identifier", identifier })}
                    >
                      Delete
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="samples-title">
            <h2 id="samples-title" className={SECTION_TITLE}>
              Samples sent from the phone
            </h2>
            <p className="mb-2 px-1 text-xs font-bold text-zinc-600">
              Bank messages the phone couldn&apos;t read. Numbers are hidden before they leave the phone.
            </p>
            {load.data.samples.length === 0 ? (
              <p className={EMPTY}>None yet. If the Android app can&apos;t read a bank text, you can send a copy from its Bank SMS settings.</p>
            ) : (
              <ul className={LIST}>
                {load.data.samples.map((sample) => (
                  <SampleRow key={sample.id} sample={sample} />
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      {deleting?.kind === "rule" && (
        <ConfirmDelete
          title={`Delete the rule for ${deleting.rule.display}?`}
          body="New messages from this payee will come to To review again."
          path={`/payee-rules/${deleting.rule.id}`}
          onClose={() => setDeleting(null)}
          onDone={(message) => {
            setDeleting(null);
            setNotice(message);
            fetchAll();
          }}
        />
      )}
      {deleting?.kind === "identifier" && (
        <ConfirmDelete
          title={`Delete ${maskLast4(deleting.identifier.last4)}?`}
          body={`Messages for this number will no longer go to ${deleting.identifier.account_name} by themselves.`}
          path={`/sms/identifiers/${deleting.identifier.id}`}
          onClose={() => setDeleting(null)}
          onDone={(message) => {
            setDeleting(null);
            setNotice(message);
            fetchAll();
          }}
        />
      )}
    </div>
  );
}

function SampleRow({ sample }: { sample: Sample }) {
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(`${sample.sender}: ${sample.text}`);
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
  }

  return (
    <li className={ROW}>
      <div className="min-w-32 flex-1">
        <p className="text-xs font-black">
          {sample.sender} <span className="font-bold text-zinc-600">· {formatFullDate(sample.created_at.slice(0, 10))}</span>
        </p>
        <p className="text-sm font-bold [overflow-wrap:anywhere]" title={sample.text}>
          {trimSampleText(sample.text)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span aria-live="polite" className="text-xs font-bold text-zinc-600">
          {copied === "yes" ? "Copied" : copied === "failed" ? "Couldn't copy" : ""}
        </span>
        <button type="button" className={ROW_ACTION} aria-label={`Copy the message from ${sample.sender}`} onClick={copy}>
          Copy
        </button>
      </div>
    </li>
  );
}

type RuleFormProps = {
  rule: PayeeRule;
  accounts: Account[];
  categories: string[];
  onCancel: () => void;
  onSaved: (rule: PayeeRule) => void;
  onStale: (message: string) => void;
};

const RULE_FIELDS = ["category", "to_account_id", "template_id"] as const;

// Edits a rule in its row: a category, or a transfer to one of the accounts. A reminder tie can only be removed.
function RuleForm({ rule, accounts, categories, onCancel, onSaved, onStale }: RuleFormProps) {
  const [kind, setKind] = useState<"category" | "transfer">(rule.to_account_id !== null ? "transfer" : "category");
  const [category, setCategory] = useState(rule.category ?? "");
  const [accountId, setAccountId] = useState(rule.to_account_id === null ? "" : String(rule.to_account_id));
  const [untie, setUntie] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const prefix = `rule${rule.id}`;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setErrors({});
    setFormError(null);
    const payload: Record<string, unknown> =
      kind === "category"
        ? { category: category.trim() || null, to_account_id: null }
        : { category: null, to_account_id: accountId === "" ? null : Number(accountId) };
    if (untie) payload.template_id = null;
    try {
      onSaved(await apiFetch<PayeeRule>(`/payee-rules/${rule.id}`, { method: "PATCH", body: JSON.stringify(payload) }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) void logout();
      else if (err instanceof ApiError && err.status === 422) {
        const { fields, general } = splitErrors(err.body, RULE_FIELDS);
        setErrors(fields);
        if (general.length > 0) setFormError(general.join(" "));
      } else if (err instanceof ApiError && err.status === 404) onStale(errorMessage(err));
      else setFormError(errorMessage(err));
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  const fieldError = (key: string) =>
    errors[key] ? (
      <p id={`${prefix}-e-${key}`} className={ERROR}>
        {errors[key]}
      </p>
    ) : null;

  return (
    <form onSubmit={save} noValidate className="flex flex-col gap-3 bg-due px-3.5 py-3">
      <p className="text-sm font-extrabold [overflow-wrap:anywhere]">{rule.display}</p>
      <Segmented
        label={`What ${rule.display} is`}
        value={kind}
        onChange={setKind}
        options={[
          { value: "category", label: "A category" },
          { value: "transfer", label: "A transfer" },
        ]}
      />
      {kind === "category" ? (
        <div>
          <label htmlFor={`${prefix}-category`} className="mb-1 block text-xs font-black tracking-wide uppercase">
            Category
          </label>
          <ComboBox
            id={`${prefix}-category`}
            value={category}
            onChange={setCategory}
            options={categories.map((c) => ({ value: c, label: c }))}
            disabled={saving}
            invalid={Boolean(errors.category)}
            describedBy={errors.category ? `${prefix}-e-category` : undefined}
            maxLength={40}
          />
          {fieldError("category")}
        </div>
      ) : (
        <div>
          <label htmlFor={`${prefix}-account`} className="mb-1 block text-xs font-black tracking-wide uppercase">
            To account
          </label>
          <Select
            id={`${prefix}-account`}
            value={accountId}
            onChange={setAccountId}
            placeholder="Choose an account"
            options={accounts.map((a) => ({ value: String(a.id), label: a.name }))}
            disabled={saving}
            invalid={Boolean(errors.to_account_id)}
            describedBy={errors.to_account_id ? `${prefix}-e-to_account_id` : undefined}
          />
          {fieldError("to_account_id")}
        </div>
      )}
      {rule.template_id !== null && (
        <label className="flex items-center gap-2 text-sm font-extrabold">
          <input
            type="checkbox"
            checked={untie}
            disabled={saving}
            onChange={(e) => setUntie(e.target.checked)}
            className="size-4 accent-ink"
          />
          Stop ticking off {rule.template_name ?? "its reminder"}
        </label>
      )}
      {fieldError("template_id")}
      {formError && (
        <p role="alert" className="text-sm font-extrabold text-loss">
          {formError}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={SMALL_GREEN} disabled={saving}>
          {saving ? "Saving..." : "Save"}
        </button>
        <button type="button" className={ROW_ACTION} disabled={saving} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
