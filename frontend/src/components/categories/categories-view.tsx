"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import {
  type Category,
  type CategoryKind,
  type CategoryTree,
  FALLBACK_COLOUR,
  type MergeResult,
  PALETTE,
  categoryPayload,
  iconEmoji,
  mergeTargets,
  mergeText,
  parentOptions,
  splitArchived,
} from "@/lib/categories";
import { DIALOG, INPUT, PRIMARY, QUIET, ROW_ACTION } from "@/components/investments/shared";
import { FOCUS, PageHeader, Segmented, TABLE, TD, TD_NUM, TH } from "@/components/ui/chunky";
import { Select } from "@/components/ui/select";

type Load = { status: "loading" } | { status: "error" } | { status: "ready"; tree: CategoryTree };
type Dialog =
  | { kind: "none" }
  | { kind: "edit"; category: Category | null }
  | { kind: "merge"; category: Category };

const LABEL = "mb-1 block text-xs font-black tracking-wide uppercase";
const KINDS: { value: CategoryKind; label: string }[] = [
  { value: "expense", label: "Spending" },
  { value: "income", label: "Income" },
];

function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

function problems(err: unknown, fields: readonly string[]): { fields: Record<string, string>; general: string[] } {
  if (err instanceof ApiError) return splitErrors(err.body, fields);
  return { fields: {}, general: ["Something went wrong. Try again."] };
}

export function CategoriesView() {
  const [kind, setKind] = useState<CategoryKind>("expense");
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [dialog, setDialog] = useState<Dialog>({ kind: "none" });
  const [notice, setNotice] = useState<string | null>(null);

  const fetchTree = useCallback(() => {
    apiFetch<CategoryTree>("/categories")
      .then((tree) => setLoad({ status: "ready", tree }))
      .catch((err: unknown) => {
        if (isUnauthorized(err)) void logout();
        else setLoad({ status: "error" });
      });
  }, []);

  useEffect(() => {
    fetchTree();
  }, [fetchTree]);

  async function setArchived(category: Category, archived: boolean) {
    setNotice(null);
    try {
      await apiFetch(`/categories/${category.id}`, { method: "PATCH", body: JSON.stringify({ archived }) });
      setNotice(archived ? `${category.name} is archived. Its history stays.` : `${category.name} is back in the pickers.`);
    } catch (err) {
      if (isUnauthorized(err)) return void logout();
      setNotice(problems(err, []).general.join(" ") || Object.values(problems(err, []).fields).join(" "));
    }
    fetchTree();
  }

  const list = load.status === "ready" ? load.tree[kind] : [];
  const { live, archived } = splitArchived(list);
  const close = () => setDialog({ kind: "none" });

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Categories"
        action={
          <button type="button" className={PRIMARY} onClick={() => setDialog({ kind: "edit", category: null })}>
            + New category
          </button>
        }
      />
      <p className="mb-4 text-sm font-bold text-zinc-600">
        Rename, nest, merge or archive. Merging moves every transaction, reminder and payee rule. Archived categories
        leave the pickers but keep their history. See where the money went on the{" "}
        <Link href="/cash-flow" className={`rounded underline ${FOCUS}`}>
          month report
        </Link>
        .
      </p>
      <div className="mb-4">
        <Segmented label="Kind" options={KINDS} value={kind} onChange={setKind} />
      </div>
      {notice ? (
        <p role="status" className="mb-4 rounded-[14px] border-[2.5px] border-ink bg-due px-3 py-2 text-sm font-extrabold">
          {notice}
        </p>
      ) : null}
      {load.status === "loading" && (
        <p role="status" className="text-sm font-bold text-zinc-600">
          Loading categories...
        </p>
      )}
      {load.status === "error" && (
        <p role="alert" className="text-sm font-extrabold">
          We couldn&apos;t load your categories. Reload the page to try again.
        </p>
      )}
      {load.status === "ready" && (
        <>
          <CategoryList
            categories={live}
            all={list}
            caption={kind === "expense" ? "Spending categories" : "Income categories"}
            onEdit={(c) => setDialog({ kind: "edit", category: c })}
            onMerge={(c) => setDialog({ kind: "merge", category: c })}
            onArchive={(c) => void setArchived(c, true)}
          />
          {archived.length > 0 && (
            <section aria-labelledby="archived-title" className="mt-6">
              <h2 id="archived-title" className="mb-2 text-xs font-black tracking-wide uppercase">
                Archived
              </h2>
              <ul className="flex flex-wrap gap-2">
                {archived.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center gap-2 rounded-full border-[2.5px] border-ink bg-card py-1 pr-1 pl-3 text-sm font-extrabold"
                  >
                    <span aria-hidden="true">{iconEmoji(c.icon)}</span>
                    {c.name}
                    <button type="button" className={ROW_ACTION} onClick={() => void setArchived(c, false)}>
                      Restore
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {dialog.kind === "edit" && load.status === "ready" && (
        <EditDialog
          category={dialog.category}
          kind={dialog.category?.kind ?? kind}
          list={load.tree[dialog.category?.kind ?? kind]}
          icons={load.tree.icons}
          onClose={close}
          onSaved={(message) => {
            close();
            setNotice(message);
            fetchTree();
          }}
        />
      )}
      {dialog.kind === "merge" && load.status === "ready" && (
        <MergeDialog
          category={dialog.category}
          list={load.tree[dialog.category.kind]}
          onClose={close}
          onMerged={(message) => {
            close();
            setNotice(message);
            fetchTree();
          }}
        />
      )}
    </div>
  );
}

function CategoryList({
  categories,
  all,
  caption,
  onEdit,
  onMerge,
  onArchive,
}: {
  categories: Category[];
  all: Category[];
  caption: string;
  onEdit: (c: Category) => void;
  onMerge: (c: Category) => void;
  onArchive: (c: Category) => void;
}) {
  if (categories.length === 0) {
    return <p className="text-sm font-extrabold">No categories yet. Add one to start.</p>;
  }
  return (
    <div className="overflow-x-auto pb-1">
      <table className={TABLE}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" className={TH}>
              Category
            </th>
            <th scope="col" className={`${TH} text-right`}>
              Transactions
            </th>
            <th scope="col" className={`${TH} w-px`}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {categories.map((c) => {
            const nested = c.parent_id !== null;
            const hasLiveChildren = all.some((x) => x.parent_id === c.id && !x.archived);
            return (
              <tr key={c.id}>
                <td className={`${TD} w-full min-w-48 ${nested ? "pl-10" : ""}`}>
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="inline-flex size-7 shrink-0 items-center justify-center rounded-[9px] border-[2.5px] border-ink text-sm"
                      style={{ background: c.colour ?? FALLBACK_COLOUR }}
                    >
                      {iconEmoji(c.icon)}
                    </span>
                    <span className={`[overflow-wrap:anywhere] ${nested ? "" : "font-extrabold"}`}>{c.name}</span>
                    {c.fixed ? (
                      <span className="rounded-full border-[1.5px] border-ink bg-blue/20 px-2 text-[11px] font-black">
                        built in
                      </span>
                    ) : null}
                  </span>
                </td>
                <td className={TD_NUM}>
                  <Link
                    href={`/transactions?category=${encodeURIComponent(c.name)}&from=2000-01-01`}
                    className={`rounded hover:underline ${FOCUS}`}
                    aria-label={`${c.transaction_count} transactions in ${c.name}`}
                  >
                    {c.transaction_count}
                  </Link>
                </td>
                <td className={`${TD} whitespace-nowrap`}>
                  <div className="flex justify-end gap-1.5">
                    <button type="button" className={ROW_ACTION} aria-label={`Edit ${c.name}`} onClick={() => onEdit(c)}>
                      Edit
                    </button>
                    {!c.fixed && (
                      <>
                        <button
                          type="button"
                          className={ROW_ACTION}
                          aria-label={`Merge ${c.name} into another category`}
                          onClick={() => onMerge(c)}
                        >
                          Merge
                        </button>
                        <button
                          type="button"
                          className={ROW_ACTION}
                          aria-label={`Archive ${c.name}`}
                          disabled={hasLiveChildren}
                          title={hasLiveChildren ? "Move or archive its subcategories first" : undefined}
                          onClick={() => onArchive(c)}
                        >
                          Archive
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function useModal() {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return ref;
}

const FIELDS = ["name", "parent_id", "icon", "colour"] as const;

function EditDialog({
  category,
  kind,
  list,
  icons,
  onClose,
  onSaved,
}: {
  category: Category | null;
  kind: CategoryKind;
  list: Category[];
  icons: string[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const ref = useModal();
  const [form, setForm] = useState({
    name: category?.name ?? "",
    parent_id: category?.parent_id === null || category === null ? "" : String(category.parent_id),
    icon: category?.icon ?? "",
    colour: category?.colour ?? "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const hasChildren = category !== null && list.some((c) => c.parent_id === category.id);
  const parents = parentOptions(list, category);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    const body = categoryPayload(form, category, kind);
    if (category !== null && Object.keys(body).length === 0) return onClose();
    setSaving(true);
    setErrors({});
    setGeneral(null);
    try {
      const saved = await apiFetch<Category>(category ? `/categories/${category.id}` : "/categories", {
        method: category ? "PATCH" : "POST",
        body: JSON.stringify(body),
      });
      onSaved(category ? `Saved ${saved.name}.` : `Added ${saved.name}.`);
    } catch (err) {
      if (isUnauthorized(err)) return void logout();
      const found = problems(err, FIELDS);
      setErrors(found.fields);
      setGeneral(found.general.length > 0 ? found.general.join(" ") : null);
    } finally {
      setSaving(false);
    }
  }

  const error = (key: string) =>
    errors[key] ? (
      <p id={`cat-${key}-error`} className="mt-1 text-xs font-extrabold text-loss">
        {errors[key]}
      </p>
    ) : null;

  return (
    <dialog ref={ref} aria-labelledby="category-dialog-title" onClose={onClose} className={DIALOG}>
      <form onSubmit={submit} noValidate>
        <div className="flex flex-col gap-4 px-5 py-4">
          <h2 id="category-dialog-title" className="text-base font-black">
            {category ? `Edit ${category.name}` : kind === "expense" ? "New spending category" : "New income category"}
          </h2>
          <div>
            <label htmlFor="cat-name" className={LABEL}>
              Name
            </label>
            <input
              id="cat-name"
              className={INPUT}
              maxLength={40}
              value={form.name}
              disabled={category?.fixed}
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={errors.name ? "cat-name-error" : undefined}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
            {category?.fixed ? (
              <p className="mt-1 text-xs font-bold text-zinc-600">The app uses this name itself, so it stays.</p>
            ) : null}
            {error("name")}
          </div>
          <div>
            <label htmlFor="cat-parent" className={LABEL}>
              Inside
            </label>
            <Select
              id="cat-parent"
              value={form.parent_id}
              disabled={hasChildren}
              invalid={!!errors.parent_id}
              options={[
                { value: "", label: "Nothing (top level)" },
                ...parents.map((p) => ({ value: String(p.id), label: p.name })),
              ]}
              onChange={(value) => setForm((f) => ({ ...f, parent_id: value }))}
            />
            {hasChildren ? (
              <p className="mt-1 text-xs font-bold text-zinc-600">It has subcategories, so it stays at the top level.</p>
            ) : null}
            {error("parent_id")}
          </div>
          <fieldset>
            <legend className={LABEL}>Icon</legend>
            <div className="flex flex-wrap gap-1.5">
              {icons.map((icon) => (
                <button
                  key={icon}
                  type="button"
                  aria-pressed={form.icon === icon}
                  aria-label={icon}
                  title={icon}
                  onClick={() => setForm((f) => ({ ...f, icon }))}
                  className={`flex size-9 items-center justify-center rounded-[10px] border-[2.5px] text-base ${form.icon === icon ? "border-ink bg-yellow" : "border-zinc-200 bg-card hover:border-ink"} ${FOCUS}`}
                >
                  <span aria-hidden="true">{iconEmoji(icon)}</span>
                </button>
              ))}
            </div>
            {error("icon")}
          </fieldset>
          <fieldset>
            <legend className={LABEL}>Colour</legend>
            <div className="flex flex-wrap gap-1.5">
              {PALETTE.map((colour) => (
                <button
                  key={colour}
                  type="button"
                  aria-pressed={form.colour === colour}
                  aria-label={colour}
                  onClick={() => setForm((f) => ({ ...f, colour }))}
                  className={`size-8 rounded-full border-[2.5px] border-ink ${form.colour === colour ? "ring-[3px] ring-ink ring-offset-2" : ""} ${FOCUS}`}
                  style={{ background: colour }}
                />
              ))}
            </div>
            {error("colour")}
          </fieldset>
          {general ? (
            <p role="alert" className="text-sm font-extrabold text-loss">
              {general}
            </p>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t-[2.5px] border-ink px-5 py-3">
          <button type="button" className={QUIET} disabled={saving} onClick={() => ref.current?.close()}>
            Cancel
          </button>
          <button type="submit" className={PRIMARY} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function MergeDialog({
  category,
  list,
  onClose,
  onMerged,
}: {
  category: Category;
  list: Category[];
  onClose: () => void;
  onMerged: (message: string) => void;
}) {
  const ref = useModal();
  const targets = mergeTargets(list, category);
  const [into, setInto] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const target = targets.find((t) => String(t.id) === into);

  async function merge() {
    if (saving || !target) return;
    setSaving(true);
    setError(null);
    try {
      const result = await apiFetch<MergeResult>(`/categories/${category.id}/merge`, {
        method: "POST",
        body: JSON.stringify({ into_id: target.id }),
      });
      onMerged(mergeText(result));
    } catch (err) {
      if (isUnauthorized(err)) return void logout();
      const found = problems(err, []);
      setError([...found.general, ...Object.values(found.fields)].join(" "));
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog ref={ref} aria-labelledby="merge-title" onClose={onClose} className={DIALOG}>
      <div className="flex flex-col gap-3 px-5 py-4">
        <h2 id="merge-title" className="text-base font-black">
          Merge {category.name} into…
        </h2>
        <p className="text-sm font-bold text-zinc-600">
          Its {category.transaction_count} {category.transaction_count === 1 ? "transaction" : "transactions"}, reminders
          and payee rules move to the category you pick, and {category.name} goes away. This can&apos;t be undone.
        </p>
        <Select
          ariaLabel="Merge into"
          value={into}
          placeholder="Choose a category"
          options={targets.map((t) => ({ value: String(t.id), label: t.name }))}
          onChange={setInto}
        />
        {error ? (
          <p role="alert" className="text-sm font-extrabold text-loss">
            {error}
          </p>
        ) : null}
      </div>
      <div className="flex justify-end gap-2 border-t-[2.5px] border-ink px-5 py-3">
        <button type="button" className={QUIET} disabled={saving} onClick={() => ref.current?.close()}>
          Cancel
        </button>
        <button type="button" className={PRIMARY} disabled={saving || !target} onClick={merge}>
          {saving ? "Merging..." : target ? `Merge into ${target.name}` : "Merge"}
        </button>
      </div>
    </dialog>
  );
}
