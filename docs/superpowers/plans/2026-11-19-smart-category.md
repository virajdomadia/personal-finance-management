# Smart Category Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Typing a note in the transaction dialog auto-picks the category, first from the owner's own history and then from a built-in keyword list.

**Architecture:** A backend module `app/api/suggest.py` holds the keyword map and the `history → keywords → None` lookup. A new `GET /api/transactions/suggest-category` exposes it. Pure helpers in `frontend/src/lib/transactions.ts` build the request and apply the answer. The dialog calls them on a 300 ms debounce and never overrides a category the owner picked.

**Tech Stack:** FastAPI + SQLAlchemy (pytest on in-memory SQLite), Next.js 16 / React 19 (node:test on `.mjs`), Tailwind chunky UI.

**Spec:** `docs/superpowers/specs/2026-11-19-smart-category-design.md`

## Global Constraints

- No outside services and no new dependencies.
- No new database table and no migration: history is the existing `transactions` rows.
- The endpoint is read-only. It must never create a category (do not call `resolve`/`usable`).
- Never replace a category the owner chose by hand in this dialog.
- The hint copy is exactly `Auto-picked`.
- Debounce is 300 ms.
- Work in a git worktree off `main` (superpowers:using-git-worktrees), branch `feat/smart-category`. The main checkout's `feat/corporate-actions` has uncommitted work, so don't touch it. Copy the spec file (untracked in the main checkout) into the worktree and commit it with Task 1.

## Review Focus

1. **Messy typing.** `"  Ice   Cream "` matches both history and keywords as `"ice cream"`. Tested in Task 1.
2. **Plurals and words inside words.** `"ice creams"` matches `ice cream`, but `"steam iron"` does not match `tea` and `"scream"` does not match `cream`. Tested in Task 1.
3. **History pointing at a category that has since changed.** A merged or renamed category gives the new name. An archived one is skipped and the keyword list is tried next. Tested in Task 1.
4. **Late answers.** A suggestion arriving after the owner picked a category, or after the note changed again, must not apply. Pinned by `applySuggestion` in Task 2 and the touched ref and stale flag in Task 3.
5. **Changing type.** Switching expense to income clears the category (existing behaviour) and re-enables auto-pick for the new type. Covered in Task 3.

---

### Task 1: Backend suggester and endpoint

**Files:**
- Create: `backend/app/api/suggest.py`
- Modify: `backend/app/api/categories.py` (add `current_name` under "Resolving a typed name")
- Modify: `backend/app/api/routes/transactions.py` (new route beside `list_categories`, line ~517, declared before any `/{id}` route)
- Test: `backend/tests/test_suggest_category.py`
- Add: `docs/superpowers/specs/2026-11-19-smart-category-design.md`

**Interfaces:**
- Produces:
  - `categories.current_name(db: Session, user_id: int, kind: str, name: str) -> str | None`: the live name `name` resolves to through merges and renames (via `_find`), or `None` when it is unknown or archived. Seeds the defaults but never creates a category.
  - `suggest.normalise(note: str) -> str`: case-folds, trims, and collapses runs of whitespace to one space.
  - `suggest.KEYWORDS: dict[str, dict[str, str]]`: `{"expense": {phrase: category}, "income": {...}}`. Phrases are already normalised, and the categories are default names from `DEFAULTS`.
  - `suggest.keyword_category(note: str, kind: str) -> str | None`: the default category name for the longest phrase that matches, or `None`.
  - `suggest.suggest_category(db: Session, user_id: int, kind: str, note: str) -> tuple[str | None, str | None]`: returns `(category, source)`, where source is `"history"`, `"keywords"` or `None`.
  - `GET /api/transactions/suggest-category?type=expense|income&note=…` returns `{"category": str | null, "source": "history" | "keywords" | null}`. `type` is any other value → 422. `note` has a 200-character limit.

- [ ] **Step 1: Write the failing tests** in `backend/tests/test_suggest_category.py`. Reuse `auth`/`Headers` from `tests.test_accounts`, `account`/`expense`/`income` from `tests.test_transactions`, and `create`/`patch`/`merge`/`find` from `tests.test_categories`. Add a helper `suggest(headers, note, type_="expense") -> dict` that GETs the endpoint and asserts 200.

```python
def test_keywords_pick_ice_cream_for_a_new_user(headers):
    assert suggest(headers, "ice cream") == {"category": "Food and dining", "source": "keywords"}

@pytest.mark.parametrize("note,category", [
    ("milk", "Groceries"), ("petrol", "Fuel"), ("uber to office", "Transport"),
    ("Netflix", "Entertainment"), ("medicine", "Health"), ("electricity bill", "Utilities"),
    ("rent", "Housing"),
])
def test_everyday_keywords(headers, note, category):
    assert suggest(headers, note)["category"] == category

def test_income_keywords(headers):
    assert suggest(headers, "salary", "income")["category"] == "Salary"

def test_messy_spacing_and_case(headers):
    assert suggest(headers, "  Ice   Cream ")["category"] == "Food and dining"

def test_plurals_match_but_words_inside_words_do_not(headers):
    assert suggest(headers, "ice creams")["category"] == "Food and dining"
    assert suggest(headers, "steam iron")["category"] != "Food and dining"   # not "tea"
    assert suggest(headers, "scream")["category"] is None                    # not "cream"

def test_longest_phrase_wins(headers):
    # KEYWORDS must map "milkshake" → Food and dining and "milk" → Groceries
    assert suggest(headers, "milkshake")["category"] == "Food and dining"

def test_unknown_word_gives_nothing(headers):
    assert suggest(headers, "zxqv") == {"category": None, "source": None}

def test_blank_note_gives_nothing(headers):
    assert suggest(headers, "   ") == {"category": None, "source": None}

def test_history_beats_keywords(headers):
    cash = account(headers)
    assert expense(headers, cash, category="Shopping", note="Ice Cream").status_code == 201
    assert suggest(headers, "ice cream") == {"category": "Shopping", "source": "history"}

def test_most_recent_history_wins(headers):
    cash = account(headers)
    expense(headers, cash, category="Shopping", note="momos", date="2026-01-01")
    expense(headers, cash, category="Food and dining", note="momos", date="2026-02-01")
    assert suggest(headers, "momos") == {"category": "Food and dining", "source": "history"}

def test_history_is_per_kind(headers):
    cash = account(headers)
    income(headers, cash, category="Gift", note="ice cream")
    assert suggest(headers, "ice cream")["source"] == "keywords"

def test_history_follows_a_rename(headers):
    cash = account(headers)
    expense(headers, cash, category="Shopping", note="momos")
    patch(headers, find(headers, "Shopping")["id"], name="Stuff")
    assert suggest(headers, "momos")["category"] == "Stuff"

def test_archived_history_falls_through_to_keywords(headers):
    cash = account(headers)
    expense(headers, cash, category="Treats", note="ice cream")
    patch(headers, find(headers, "Treats")["id"], archived=True)
    assert suggest(headers, "ice cream") == {"category": "Food and dining", "source": "keywords"}

def test_keyword_follows_a_merge_and_skips_an_archived_default(headers):
    food = find(headers, "Food and dining")["id"]
    merge(headers, food, find(headers, "Groceries")["id"])
    assert suggest(headers, "ice cream")["category"] == "Groceries"
    patch(headers, find(headers, "Fuel")["id"], archived=True)
    assert suggest(headers, "petrol")["category"] is None

def test_suggesting_creates_no_category(headers, db_session):
    before = db_session.scalar(select(func.count()).select_from(Category))
    suggest(headers, "zxqv")
    assert db_session.scalar(select(func.count()).select_from(Category)) == before

def test_other_users_history_is_private(headers, db_session, monkeypatch): ...
    # a second user's "momos" → Shopping is invisible: first user gets source None.
    # Follow test_categories.test_another_users_categories_are_private for making user two.

def test_bad_type_is_rejected(headers):
    response = client.get(URL, params={"type": "transfer", "note": "x"}, headers=headers)
    assert response.status_code == 422
```

- [ ] **Step 2: Run to see them fail**

Run: `cd backend && uv run pytest tests/test_suggest_category.py -v`
Expected: FAIL (404 / import error)

- [ ] **Step 3: Add `current_name` to `app/api/categories.py`.** Call `ensure_seeded`, then `_find(db, user_id, kind, name_key(name))`. Return `None` when there's no row or `archived_at` is set, otherwise return `found.name`.

- [ ] **Step 4: Create `app/api/suggest.py`** with a module docstring that says what it does and the lookup order.
  - **`KEYWORDS`:** about 150 to 250 everyday Indian entries across the default expense categories. Examples: chai, coffee, ice cream, milkshake, momos, pizza, swiggy, zomato → Food and dining; milk, vegetables, atta, dmart, bigbasket, blinkit → Groceries; petrol, diesel, cng → Fuel; uber, ola, auto, metro, bus, parking, toll → Transport; rent, maintenance → Housing; electricity, water bill, gas cylinder, wifi, recharge → Utilities; netflix, movie, hotstar → Entertainment; medicine, doctor, pharmacy → Health; amazon, clothes, shoes → Shopping; fees, books, course → Education; flight, hotel, train ticket → Travel; donation → Gifts and donations. Add a few income entries: salary, bonus → Salary; refund, cashback → Refund; interest → Interest.
  - **Never map to a fixed category** except Interest, which is fine for income.
  - **`keyword_category`:** check phrases longest first. Each phrase matches as `rf"\b{re.escape(phrase)}(?:e?s)?\b"` on `normalise(note)`.
  - **`suggest_category`:**
    1. Return `(None, None)` for a blank normalised note.
    2. History: the latest `Transaction` where `user_id` matches, `type == kind` (EMI excluded on purpose), the category is not null, and `func.lower(func.trim(Transaction.note)) == normalised`, ordered by `date desc, id desc`, limit 1. Resolve that category with `current_name`, and if it gives a name, return it as `"history"`.
    3. Keywords: run the keyword match and pass the result through `current_name`. A hit is `"keywords"`.
    4. Otherwise return `(None, None)`.

- [ ] **Step 5: Add the route** to `routes/transactions.py`, as `suggest_category_route(user, db, type: Literal["expense", "income"], note: Annotated[str, Query(max_length=200)] = "") -> CategorySuggestion`. Add a pydantic `CategorySuggestion` with `category: str | None` and `source: Literal["history", "keywords"] | None`. Call `db.commit()` after it, as `list_categories` does, because a first read seeds the defaults.

- [ ] **Step 6: Run the tests until they pass, then lint**

Run: `cd backend && uv run pytest tests/test_suggest_category.py tests/test_categories.py tests/test_transactions.py -v && uv run ruff check . && uv run ruff format --check .`
Expected: all PASS, ruff clean

- [ ] **Step 7: Commit**

```bash
git add backend/app/api/suggest.py backend/app/api/categories.py backend/app/api/routes/transactions.py backend/tests/test_suggest_category.py docs/superpowers/specs/2026-11-19-smart-category-design.md docs/superpowers/plans/2026-11-19-smart-category.md
git commit -m "feat: suggest a category from the note (history, then keywords)"
```

---

### Task 2: Frontend helpers

**Files:**
- Modify: `frontend/src/lib/transactions.ts`
- Test: `frontend/src/lib/transactions.test.mjs` (already in the `test` script)

**Interfaces:**
- Consumes: the Task 1 endpoint's JSON.
- Produces:
  - `type CategorySuggestion = { category: string | null; source: "history" | "keywords" | null }`
  - `suggestPath(type: TransactionType, note: string): string | null`: returns `null` unless the type is `expense` or `income` and the trimmed note is at least 2 characters. Otherwise it returns `` `/transactions/suggest-category?${new URLSearchParams({ type, note: note.trim() })}` ``.
  - `applySuggestion(form: TransactionForm, touched: boolean, category: string | null): TransactionForm`: returns `form` unchanged (the same object) when `touched` is true. Otherwise it returns `{ ...form, category: category ?? "" }`.

- [ ] **Step 1: Write the failing tests**

```js
test("suggestPath asks only for expense and income notes of two or more characters", () => {
  assert.equal(suggestPath("expense", " ice cream "), "/transactions/suggest-category?type=expense&note=ice+cream");
  assert.equal(suggestPath("income", "salary"), "/transactions/suggest-category?type=income&note=salary");
  assert.equal(suggestPath("expense", " a "), null);
  assert.equal(suggestPath("transfer", "rent"), null);
  assert.equal(suggestPath("emi", "loan"), null);
});

test("applySuggestion fills or clears an untouched category and never overrides a picked one", () => {
  const form = { ...blankForm(), type: "expense", category: "" };
  assert.equal(applySuggestion(form, false, "Food and dining").category, "Food and dining");
  assert.equal(applySuggestion({ ...form, category: "Food and dining" }, false, null).category, "");
  const picked = { ...form, category: "Shopping" };
  assert.equal(applySuggestion(picked, true, "Food and dining"), picked);
});
```

(Check `blankForm`'s real signature in `transactions.ts` and adjust the call if it takes arguments.)

- [ ] **Step 2: Run them and confirm they fail.** Run `npm --prefix frontend test`. Expected: FAIL (not exported).
- [ ] **Step 3: Implement the type and both helpers** in `transactions.ts`, near `incomeCategories`.
- [ ] **Step 4: Run them and confirm they pass.** Run `npm --prefix frontend test && npm --prefix frontend run lint`. Expected: PASS, lint clean.
- [ ] **Step 5: Commit** with `git commit -m "feat: helpers to request and apply a category suggestion"`.

---

### Task 3: Wire the dialog

**Files:**
- Modify: `frontend/src/components/transactions/transaction-dialog.tsx`

**Interfaces:**
- Consumes: `suggestPath`, `applySuggestion` and `CategorySuggestion` from Task 2, plus `apiFetch`.

- [ ] **Step 1: Track whether the owner chose the category.**
  - Add `const [categoryTouched, setCategoryTouched] = useState(() => form.category !== "")` and a `touchedRef` mirroring it. An existing or pre-filled category counts as chosen.
  - The category `ComboBox` gets `onChange={(v) => { setCategoryTouched(true); touchedRef.current = true; set("category", v); }}`.
  - `changeType` resets both the state and the ref to `false`.
- [ ] **Step 2: Add the suggestion effect.**
  - It depends on `[form.note, type, categoryTouched, depositIncome]`, where `depositIncome` is the existing condition that shows the fixed "Interest" line.
  - Return early when the category is touched or `depositIncome` is true.
  - When `path` is `null`, run `setForm((f) => applySuggestion(f, touchedRef.current, null))` and return.
  - Otherwise start a 300 ms timer. When it fires, call `apiFetch<CategorySuggestion>(path)`, then `setForm((f) => applySuggestion(f, touchedRef.current, s.category))` unless a `stale` flag is set. Catch and ignore any error.
  - The cleanup clears the timer and sets `stale = true`.
- [ ] **Step 3: Move the Note field above the Category field.** You type what you bought first, then the category fills itself. This is Claude's call, made so the auto-pick is visible as it happens.
- [ ] **Step 4: Show the hint.** When `!categoryTouched && form.category !== ""`, render `<p className={HINT} aria-live="polite">Auto-picked</p>` under the Category field. Keep the existing error `<p>` working.
- [ ] **Step 5: Verify**

Run: `npm --prefix frontend test && npm --prefix frontend run lint && npm --prefix frontend run build`
Expected: PASS, no lint errors, build succeeds.

Then run the app (`npm run dev`, using the `run` skill) and check in the browser:
1. **New expense:** type `ice cream` and the category becomes **Food and dining** with **Auto-picked** showing.
2. **Your pick stays:** choose **Shopping**, change the note to `petrol`, and the category stays **Shopping**.
3. **Learning:** save a `momos` expense as **Shopping**, open a new expense, type `momos`, and it picks **Shopping**.
4. **Switching type:** switch to Income and type `salary`, and it picks **Salary**.
5. **Editing:** open an existing transaction with a category, change its note, and the category doesn't change.

- [ ] **Step 6: Commit** with `git commit -m "feat: auto-pick the category while typing the note"`.
