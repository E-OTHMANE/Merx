# SCHEMA — le catalogue, tel que la base le porte

<!--
  ENGENDRÉ — ne pas écrire à la main.

  Produit par `npm run schema:doc` depuis `pg_catalog`, sur la base locale
  telle qu'un `npx supabase db reset` vient de la rebâtir.
  `supabase/tests/schema-doc.test.ts` compare ce fichier à ce que le catalogue
  produit : une migration sans régénération laisse la suite rouge.

  Toute correction se fait dans une migration, puis on régénère. Corriger ce
  fichier ne corrige rien : il n'est la source de rien.
-->

Ce document décrit ce que la base **est**. Ce qu'elle **doit** être, et pourquoi,
vit dans `docs/SPEC.md` ; les décisions de chaque story dans `docs/BACKLOG.md`.
Quand les deux divergent, c'est le spec qui tranche et une migration qui corrige.

---

## Domaines

Les domaines de SPEC § 4 : tout montant est un `money_amount`, toute quantité une
`quantity`. Un `numeric` nu dans une table métier est une infraction, que
`conventions.ts` signale.

| domaine | type de base | non nul | défaut | contraintes |
| --- | --- | --- | --- | --- |
| `public.money_amount` | `numeric(12,2)` | non | — | — |
| `public.quantity` | `numeric(12,3)` | non | — | — |

---

## Énumérations

Une étiquette d'enum est une valeur que le balayage d'isolation sait fabriquer
(CLAUDE.md) : c'est pourquoi un domaine machine-lisible est préféré à un `check`
porteur d'un motif.

- `merx.rls_exception_guard` — `current_tenant`, `super_admin`, `row_tenant`, `argument_tenant`, `auth_identity`
- `public.audit_action` — `price_override`, `document_cancellation`, `credit_limit_override`, `stock_variance_approval`, `role_change`, `purchase_price_change`, `stock_adjustment`
- `public.device_prefix` — `A`, `B`, `C`, `D`, `E`, `F`, `G`, `H`, `I`, `J`, `K`, `L`, `M`, `N`, `O`, `P`, `Q`, `R`, `S`, `T`, `U`, `V`, `W`, `X`, `Y`, `Z`
- `public.price_source` — `auto`, `manual`
- `public.sale_doc_status` — `draft`, `confirmed`, `delivered`, `cancelled`
- `public.sale_doc_type` — `quote`, `order`, `delivery_note`, `return`
- `public.setting_key` — `print_header`, `default_language`, `printer_address`
- `public.stock_movement_type` — `sale`, `return`, `receipt`, `adjustment`, `inventory`, `sale_cancellation`
- `public.stock_source_type` — `sale_document`, `goods_receipt`, `inventory_session`
- `public.user_role` — `super_admin`, `owner`, `worker`

---

## Tables de `public`

16 tables : `app_user` · `audit_log` · `category` · `device` · `document_sequence` · `price_break` · `product` · `sale_document` · `sale_line` · `stock_level` · `stock_movement` · `tenant` · `tenant_setting` · `variant` · `variant_cost` · `warehouse`

### `app_user`

> Utilisateur d'un commerce. SPEC § 3, § 9 M8.

RLS activée et **forcée**.

**Registres**

- `merx.confidential_registry` (capability = manage_users)
- `merx.convention_registry` (kind = reference)

**Colonnes**

| colonne | type | non nul | défaut ou expression |
| --- | --- | --- | --- |
| `id` | `uuid` | oui | `gen_random_uuid()` |
| `auth_user_id` | `uuid` | non | — |
| `full_name` | `text` | oui | — |
| `phone` | `text` | non | — |
| `role` | `user_role` | oui | — |
| `is_active` | `boolean` | oui | `true` |
| `last_seen_at` | `timestamp with time zone` | non | — |
| `tenant_id` | `uuid` | oui | `merx.current_tenant_id()` |
| `created_at` | `timestamp with time zone` | oui | `now()` |
| `updated_at` | `timestamp with time zone` | oui | `now()` |
| `created_by` | `uuid` | non | — |
| `device_id` | `uuid` | non | — |
| `deleted_at` | `timestamp with time zone` | non | — |

**Contraintes**

| nom | genre | définition |
| --- | --- | --- |
| `app_user_auth_user_id_fkey` | clé étrangère | `FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE SET NULL` |
| `app_user_auth_user_id_key` | unicité | `UNIQUE (auth_user_id)` |
| `app_user_created_by_fkey` | clé étrangère | `FOREIGN KEY (tenant_id, created_by) REFERENCES app_user(tenant_id, id)` |
| `app_user_pkey` | clé primaire | `PRIMARY KEY (id)` |
| `app_user_tenant_id_fkey` | clé étrangère | `FOREIGN KEY (tenant_id) REFERENCES tenant(id)` |
| `app_user_tenant_id_id_key` | unicité | `UNIQUE (tenant_id, id)` |

**Index** (hors ceux qui servent une contrainte)

| nom | définition |
| --- | --- |
| `app_user_tenant_id_idx` | `CREATE INDEX app_user_tenant_id_idx ON public.app_user USING btree (tenant_id)` |

**Policies**

| nom | genre | opérations | rôles | using | with check |
| --- | --- | --- | --- | --- | --- |
| `capability_restriction` | restrictive | les quatre opérations | `authenticated` | `merx.can('manage_users'::text)` | `merx.can('manage_users'::text)` |
| `super_admin_all` | permissive | les quatre opérations | `authenticated` | `merx.is_super_admin()` | `merx.is_super_admin()` |
| `tenant_isolation` | permissive | les quatre opérations | `authenticated` | `(tenant_id = merx.current_tenant_id())` | `(tenant_id = merx.current_tenant_id())` |

**Triggers**

| nom | moment | événements | portée | condition | fonction |
| --- | --- | --- | --- | --- | --- |
| `app_user_protect_own_role` | BEFORE | UPDATE | ligne | — | `merx.protect_own_role` |
| `set_updated_at` | BEFORE | UPDATE | ligne | — | `merx.set_updated_at` |

### `audit_log`

> Qui a fait quoi. En ajout seul, écrit par merx.log_audit() seulement. SPEC § 9 M8, RÈGLE M8-1 ; E1-04.

RLS activée et **forcée**.

**Registres**

- `merx.append_only_registry` (write_path = helper)
- `merx.confidential_registry` (capability = view_audit_log)
- `merx.convention_registry` (kind = business)

**Colonnes**

| colonne | type | non nul | défaut ou expression |
| --- | --- | --- | --- |
| `id` | `uuid` | oui | `gen_random_uuid()` |
| `user_id` | `uuid` | oui | — |
| `action` | `audit_action` | oui | — |
| `entity_type` | `text` | oui | — |
| `entity_id` | `uuid` | oui | — |
| `before` | `jsonb` | non | — |
| `after` | `jsonb` | non | — |
| `tenant_id` | `uuid` | oui | `merx.current_tenant_id()` |
| `created_at` | `timestamp with time zone` | oui | `now()` |
| `updated_at` | `timestamp with time zone` | oui | `now()` |
| `created_by` | `uuid` | non | — |
| `device_id` | `uuid` | non | — |

**Contraintes**

| nom | genre | définition |
| --- | --- | --- |
| `audit_log_created_by_fkey` | clé étrangère | `FOREIGN KEY (tenant_id, created_by) REFERENCES app_user(tenant_id, id)` |
| `audit_log_pkey` | clé primaire | `PRIMARY KEY (id)` |
| `audit_log_tenant_id_fkey` | clé étrangère | `FOREIGN KEY (tenant_id) REFERENCES tenant(id)` |
| `audit_log_user_id_fkey` | clé étrangère | `FOREIGN KEY (tenant_id, user_id) REFERENCES app_user(tenant_id, id)` |

**Index** (hors ceux qui servent une contrainte)

| nom | définition |
| --- | --- |
| `audit_log_tenant_created_at` | `CREATE INDEX audit_log_tenant_created_at ON public.audit_log USING btree (tenant_id, created_at DESC)` |
| `audit_log_tenant_id_idx` | `CREATE INDEX audit_log_tenant_id_idx ON public.audit_log USING btree (tenant_id)` |
| `audit_log_tenant_user_created_at` | `CREATE INDEX audit_log_tenant_user_created_at ON public.audit_log USING btree (tenant_id, user_id, created_at DESC)` |

**Policies**

| nom | genre | opérations | rôles | using | with check |
| --- | --- | --- | --- | --- | --- |
| `capability_restriction` | restrictive | les quatre opérations | `authenticated` | `merx.can('view_audit_log'::text)` | `merx.can('view_audit_log'::text)` |
| `super_admin_all` | permissive | les quatre opérations | `authenticated` | `merx.is_super_admin()` | `merx.is_super_admin()` |
| `tenant_isolation` | permissive | les quatre opérations | `authenticated` | `(tenant_id = merx.current_tenant_id())` | `(tenant_id = merx.current_tenant_id())` |

**Triggers**

| nom | moment | événements | portée | condition | fonction |
| --- | --- | --- | --- | --- | --- |
| `reject_row_mutation` | BEFORE | DELETE OR UPDATE | ligne | — | `merx.reject_row_mutation` |
| `reject_truncate` | BEFORE | TRUNCATE | instruction | — | `merx.reject_truncate` |
| `set_updated_at` | BEFORE | UPDATE | ligne | — | `merx.set_updated_at` |

### `category`

> Catégorie de produits, arborescente. SPEC § 6 M1.

RLS activée et **forcée**.

**Registres**

- `merx.convention_registry` (kind = reference)
- `merx.write_capability_registry` (capability = manage_product)

**Colonnes**

| colonne | type | non nul | défaut ou expression |
| --- | --- | --- | --- |
| `id` | `uuid` | oui | `gen_random_uuid()` |
| `name_fr` | `text` | oui | — |
| `name_ar` | `text` | non | — |
| `parent_id` | `uuid` | non | — |
| `sort_order` | `integer` | oui | `0` |
| `tenant_id` | `uuid` | oui | `merx.current_tenant_id()` |
| `created_at` | `timestamp with time zone` | oui | `now()` |
| `updated_at` | `timestamp with time zone` | oui | `now()` |
| `created_by` | `uuid` | non | — |
| `device_id` | `uuid` | non | — |
| `deleted_at` | `timestamp with time zone` | non | — |

**Contraintes**

| nom | genre | définition |
| --- | --- | --- |
| `category_created_by_fkey` | clé étrangère | `FOREIGN KEY (tenant_id, created_by) REFERENCES app_user(tenant_id, id)` |
| `category_parent_id_fkey` | clé étrangère | `FOREIGN KEY (tenant_id, parent_id) REFERENCES category(tenant_id, id) ON DELETE SET NULL (parent_id)` |
| `category_pkey` | clé primaire | `PRIMARY KEY (id)` |
| `category_tenant_id_fkey` | clé étrangère | `FOREIGN KEY (tenant_id) REFERENCES tenant(id)` |
| `category_tenant_id_id_key` | unicité | `UNIQUE (tenant_id, id)` |

**Index** (hors ceux qui servent une contrainte)

| nom | définition |
| --- | --- |
| `category_parent` | `CREATE INDEX category_parent ON public.category USING btree (tenant_id, parent_id)` |
| `category_tenant_id_idx` | `CREATE INDEX category_tenant_id_idx ON public.category USING btree (tenant_id)` |

**Policies**

| nom | genre | opérations | rôles | using | with check |
| --- | --- | --- | --- | --- | --- |
| `super_admin_all` | permissive | les quatre opérations | `authenticated` | `merx.is_super_admin()` | `merx.is_super_admin()` |
| `tenant_isolation` | permissive | les quatre opérations | `authenticated` | `(tenant_id = merx.current_tenant_id())` | `(tenant_id = merx.current_tenant_id())` |
| `write_capability_delete` | restrictive | delete | `authenticated` | `merx.can('manage_product'::text)` | — |
| `write_capability_insert` | restrictive | insert | `authenticated` | — | `merx.can('manage_product'::text)` |
| `write_capability_update` | restrictive | update | `authenticated` | `merx.can('manage_product'::text)` | `merx.can('manage_product'::text)` |

**Triggers**

| nom | moment | événements | portée | condition | fonction |
| --- | --- | --- | --- | --- | --- |
| `set_updated_at` | BEFORE | UPDATE | ligne | — | `merx.set_updated_at` |

### `device`

> Appareil d'un commerce. 'prefix' sert la numérotation hors-ligne. SPEC § 2.5, § 9 M8.

RLS activée et **forcée**.

**Registres**

- `merx.confidential_registry` (capability = manage_devices)
- `merx.convention_registry` (kind = reference)

**Colonnes**

| colonne | type | non nul | défaut ou expression |
| --- | --- | --- | --- |
| `id` | `uuid` | oui | `gen_random_uuid()` |
| `label` | `text` | oui | — |
| `prefix` | `device_prefix` | oui | — |
| `last_sync_at` | `timestamp with time zone` | non | — |
| `is_active` | `boolean` | oui | `true` |
| `tenant_id` | `uuid` | oui | `merx.current_tenant_id()` |
| `created_at` | `timestamp with time zone` | oui | `now()` |
| `updated_at` | `timestamp with time zone` | oui | `now()` |
| `created_by` | `uuid` | non | — |
| `device_id` | `uuid` | non | — |
| `deleted_at` | `timestamp with time zone` | non | — |

**Contraintes**

| nom | genre | définition |
| --- | --- | --- |
| `device_created_by_fkey` | clé étrangère | `FOREIGN KEY (tenant_id, created_by) REFERENCES app_user(tenant_id, id)` |
| `device_pkey` | clé primaire | `PRIMARY KEY (id)` |
| `device_tenant_id_fkey` | clé étrangère | `FOREIGN KEY (tenant_id) REFERENCES tenant(id)` |
| `device_tenant_id_id_key` | unicité | `UNIQUE (tenant_id, id)` |

**Index** (hors ceux qui servent une contrainte)

| nom | définition |
| --- | --- |
| `device_prefix_per_tenant` | `CREATE UNIQUE INDEX device_prefix_per_tenant ON public.device USING btree (tenant_id, prefix)` |
| `device_tenant_id_idx` | `CREATE INDEX device_tenant_id_idx ON public.device USING btree (tenant_id)` |

**Policies**

| nom | genre | opérations | rôles | using | with check |
| --- | --- | --- | --- | --- | --- |
| `capability_restriction` | restrictive | les quatre opérations | `authenticated` | `merx.can('manage_devices'::text)` | `merx.can('manage_devices'::text)` |
| `super_admin_all` | permissive | les quatre opérations | `authenticated` | `merx.is_super_admin()` | `merx.is_super_admin()` |
| `tenant_isolation` | permissive | les quatre opérations | `authenticated` | `(tenant_id = merx.current_tenant_id())` | `(tenant_id = merx.current_tenant_id())` |

**Triggers**

| nom | moment | événements | portée | condition | fonction |
| --- | --- | --- | --- | --- | --- |
| `set_updated_at` | BEFORE | UPDATE | ligne | — | `merx.set_updated_at` |

### `document_sequence`

> La borne de la numérotation locale : le plus grand numéro écrit par (commerce, appareil, type, année). Dérivée — maintenue par merx.advance_document_sequence() sur sale_document, jamais écrite à la main. Le serveur ne l'attribue pas, il la constate. RÈGLE M3-2 ; posée en E4-01, dérivée en E4-02.

RLS activée et **forcée**.

**Registres**

- `merx.convention_registry` (kind = business)
- `merx.derived_registry` (source_table = sale_document, writer_function = advance_document_sequence)

**Colonnes**

| colonne | type | non nul | défaut ou expression |
| --- | --- | --- | --- |
| `id` | `uuid` | oui | `gen_random_uuid()` |
| `doc_type` | `sale_doc_type` | oui | — |
| `year` | `smallint` | oui | — |
| `last_number` | `integer` | oui | `0` |
| `tenant_id` | `uuid` | oui | `merx.current_tenant_id()` |
| `created_at` | `timestamp with time zone` | oui | `now()` |
| `updated_at` | `timestamp with time zone` | oui | `now()` |
| `created_by` | `uuid` | non | — |
| `device_id` | `uuid` | oui | — |

**Contraintes**

| nom | genre | définition |
| --- | --- | --- |
| `document_sequence_created_by_fkey` | clé étrangère | `FOREIGN KEY (tenant_id, created_by) REFERENCES app_user(tenant_id, id)` |
| `document_sequence_device_id_fkey` | clé étrangère | `FOREIGN KEY (tenant_id, device_id) REFERENCES device(tenant_id, id)` |
| `document_sequence_last_number_check` | check | `CHECK ((last_number >= 0))` |
| `document_sequence_pkey` | clé primaire | `PRIMARY KEY (id)` |
| `document_sequence_tenant_id_fkey` | clé étrangère | `FOREIGN KEY (tenant_id) REFERENCES tenant(id)` |
| `document_sequence_year_check` | check | `CHECK ((year > 0))` |

**Index** (hors ceux qui servent une contrainte)

| nom | définition |
| --- | --- |
| `document_sequence_per_device_type_year` | `CREATE UNIQUE INDEX document_sequence_per_device_type_year ON public.document_sequence USING btree (tenant_id, device_id, doc_type, year)` |
| `document_sequence_tenant_id_idx` | `CREATE INDEX document_sequence_tenant_id_idx ON public.document_sequence USING btree (tenant_id)` |

**Policies**

| nom | genre | opérations | rôles | using | with check |
| --- | --- | --- | --- | --- | --- |
| `super_admin_all` | permissive | les quatre opérations | `authenticated` | `merx.is_super_admin()` | `merx.is_super_admin()` |
| `tenant_isolation` | permissive | les quatre opérations | `authenticated` | `(tenant_id = merx.current_tenant_id())` | `(tenant_id = merx.current_tenant_id())` |

**Triggers**

| nom | moment | événements | portée | condition | fonction |
| --- | --- | --- | --- | --- | --- |
| `reject_derived_insert` | AFTER | INSERT | ligne | — | `merx.reject_derived_write` |
| `reject_derived_truncate` | BEFORE | TRUNCATE | instruction | — | `merx.reject_derived_truncate` |
| `reject_derived_write` | BEFORE | DELETE OR UPDATE | ligne | — | `merx.reject_derived_write` |
| `set_updated_at` | BEFORE | UPDATE | ligne | — | `merx.set_updated_at` |

### `price_break`

> Grille de prix par palier d'une variante. RÈGLE M1-2, SPEC § 6.

RLS activée et **forcée**.

**Registres**

- `merx.convention_registry` (kind = reference)
- `merx.write_capability_registry` (capability = manage_price_list)

**Colonnes**

| colonne | type | non nul | défaut ou expression |
| --- | --- | --- | --- |
| `id` | `uuid` | oui | `gen_random_uuid()` |
| `variant_id` | `uuid` | oui | — |
| `min_qty` | `quantity` | oui | — |
| `unit_price` | `money_amount` | non | — |
| `tenant_id` | `uuid` | oui | `merx.current_tenant_id()` |
| `created_at` | `timestamp with time zone` | oui | `now()` |
| `updated_at` | `timestamp with time zone` | oui | `now()` |
| `created_by` | `uuid` | non | — |
| `device_id` | `uuid` | non | — |
| `deleted_at` | `timestamp with time zone` | non | — |

**Contraintes**

| nom | genre | définition |
| --- | --- | --- |
| `price_break_created_by_fkey` | clé étrangère | `FOREIGN KEY (tenant_id, created_by) REFERENCES app_user(tenant_id, id)` |
| `price_break_min_qty_check` | check | `CHECK (((min_qty)::numeric > (0)::numeric))` |
| `price_break_pkey` | clé primaire | `PRIMARY KEY (id)` |
| `price_break_tenant_id_fkey` | clé étrangère | `FOREIGN KEY (tenant_id) REFERENCES tenant(id)` |
| `price_break_unit_price_check` | check | `CHECK (((unit_price)::numeric >= (0)::numeric))` |
| `price_break_variant_id_fkey` | clé étrangère | `FOREIGN KEY (tenant_id, variant_id) REFERENCES variant(tenant_id, id) ON DELETE CASCADE` |

**Index** (hors ceux qui servent une contrainte)

| nom | définition |
| --- | --- |
| `price_break_min_qty_per_variant` | `CREATE UNIQUE INDEX price_break_min_qty_per_variant ON public.price_break USING btree (variant_id, min_qty) WHERE (deleted_at IS NULL)` |
| `price_break_tenant_id_idx` | `CREATE INDEX price_break_tenant_id_idx ON public.price_break USING btree (tenant_id)` |
| `price_break_variant` | `CREATE INDEX price_break_variant ON public.price_break USING btree (tenant_id, variant_id)` |

**Policies**

| nom | genre | opérations | rôles | using | with check |
| --- | --- | --- | --- | --- | --- |
| `super_admin_all` | permissive | les quatre opérations | `authenticated` | `merx.is_super_admin()` | `merx.is_super_admin()` |
| `tenant_isolation` | permissive | les quatre opérations | `authenticated` | `(tenant_id = merx.current_tenant_id())` | `(tenant_id = merx.current_tenant_id())` |
| `write_capability_delete` | restrictive | delete | `authenticated` | `merx.can('manage_price_list'::text)` | — |
| `write_capability_insert` | restrictive | insert | `authenticated` | — | `merx.can('manage_price_list'::text)` |
| `write_capability_update` | restrictive | update | `authenticated` | `merx.can('manage_price_list'::text)` | `merx.can('manage_price_list'::text)` |

**Triggers**

| nom | moment | événements | portée | condition | fonction |
| --- | --- | --- | --- | --- | --- |
| `keep_base_price_break` | BEFORE | DELETE | ligne | — | `merx.keep_base_price_break` |
| `pin_base_price_break` | BEFORE | UPDATE | ligne | — | `merx.pin_base_price_break` |
| `set_updated_at` | BEFORE | UPDATE | ligne | — | `merx.set_updated_at` |

### `product`

> Produit. Ne porte ni prix, ni stock, ni code-barres : tout cela est sur la variante, dont il a toujours au moins une. SPEC § 2.3, § 6 M1.

RLS activée et **forcée**.

**Registres**

- `merx.convention_registry` (kind = reference)
- `merx.creation_form_registry` (name_column = name_fr)
- `merx.write_capability_registry` (capability = manage_product)

**Colonnes**

| colonne | type | non nul | défaut ou expression |
| --- | --- | --- | --- |
| `id` | `uuid` | oui | `gen_random_uuid()` |
| `code` | `text` | non | — |
| `name_fr` | `text` | oui | — |
| `name_ar` | `text` | non | — |
| `category_id` | `uuid` | non | — |
| `brand` | `text` | non | — |
| `photo_url` | `text` | non | — |
| `unit_label` | `text` | non | — |
| `pieces_per_carton` | `integer` | non | — |
| `is_active` | `boolean` | oui | `true` |
| `tenant_id` | `uuid` | oui | `merx.current_tenant_id()` |
| `created_at` | `timestamp with time zone` | oui | `now()` |
| `updated_at` | `timestamp with time zone` | oui | `now()` |
| `created_by` | `uuid` | non | — |
| `device_id` | `uuid` | non | — |
| `deleted_at` | `timestamp with time zone` | non | — |
| `search_name` | `text` | non | engendrée : `((merx.search_fold(name_fr) \|\| ' '::text) \|\| merx.search_fold(name_ar))` |
| `search_code` | `text` | non | engendrée : `merx.search_fold(code)` |
| `code_key` | `text` | non | engendrée : `lower(code)` |

**Contraintes**

| nom | genre | définition |
| --- | --- | --- |
| `product_category_id_fkey` | clé étrangère | `FOREIGN KEY (tenant_id, category_id) REFERENCES category(tenant_id, id) ON DELETE SET NULL (category_id)` |
| `product_created_by_fkey` | clé étrangère | `FOREIGN KEY (tenant_id, created_by) REFERENCES app_user(tenant_id, id)` |
| `product_pieces_per_carton_check` | check | `CHECK ((pieces_per_carton > 0))` |
| `product_pkey` | clé primaire | `PRIMARY KEY (id)` |
| `product_tenant_id_fkey` | clé étrangère | `FOREIGN KEY (tenant_id) REFERENCES tenant(id)` |
| `product_tenant_id_id_key` | unicité | `UNIQUE (tenant_id, id)` |

**Index** (hors ceux qui servent une contrainte)

| nom | définition |
| --- | --- |
| `product_category` | `CREATE INDEX product_category ON public.product USING btree (tenant_id, category_id)` |
| `product_code_key` | `CREATE INDEX product_code_key ON public.product USING btree (code_key) WHERE ((deleted_at IS NULL) AND (code IS NOT NULL))` |
| `product_code_per_tenant` | `CREATE UNIQUE INDEX product_code_per_tenant ON public.product USING btree (tenant_id, lower(code)) WHERE ((deleted_at IS NULL) AND (code IS NOT NULL))` |
| `product_search` | `CREATE INDEX product_search ON public.product USING gin (tenant_id, (((search_name \|\| ' '::text) \|\| search_code)) gin_trgm_ops) WITH (fastupdate=off)` |
| `product_tenant_id_idx` | `CREATE INDEX product_tenant_id_idx ON public.product USING btree (tenant_id)` |

**Policies**

| nom | genre | opérations | rôles | using | with check |
| --- | --- | --- | --- | --- | --- |
| `super_admin_all` | permissive | les quatre opérations | `authenticated` | `merx.is_super_admin()` | `merx.is_super_admin()` |
| `tenant_isolation` | permissive | les quatre opérations | `authenticated` | `(tenant_id = merx.current_tenant_id())` | `(tenant_id = merx.current_tenant_id())` |
| `write_capability_delete` | restrictive | delete | `authenticated` | `merx.can('manage_product'::text)` | — |
| `write_capability_insert` | restrictive | insert | `authenticated` | — | `merx.can('manage_product'::text)` |
| `write_capability_update` | restrictive | update | `authenticated` | `merx.can('manage_product'::text)` | `merx.can('manage_product'::text)` |

**Triggers**

| nom | moment | événements | portée | condition | fonction |
| --- | --- | --- | --- | --- | --- |
| `create_default_variant` | AFTER | INSERT | ligne | — | `merx.create_default_variant` |
| `follow_code` | AFTER | UPDATE | ligne | `(new.code IS DISTINCT FROM old.code)` | `merx.follow_product_code` |
| `normalize_code` | BEFORE | INSERT OR UPDATE | ligne | — | `merx.normalize_product_code` |
| `propagate_deletion` | AFTER | UPDATE | ligne | `(new.deleted_at IS DISTINCT FROM old.deleted_at)` | `merx.propagate_product_deletion` |
| `set_updated_at` | BEFORE | UPDATE | ligne | — | `merx.set_updated_at` |

### `sale_document`

> Devis, commande ou bon de livraison. Libre tant que brouillon ; une fois confirmé, le contenu est figé et seul le statut avance. SPEC § 8, RÈGLES M3-1, M3-3 ; E4-01.

RLS activée et **forcée**.

**Registres**

- `merx.audited_registry` (action = document_cancellation, columns = {doc_type, doc_number, status, total, cancellation_reason}, row_condition = ((old.status IS DISTINCT FROM new.status) AND (new.status = 'cancelled'::public.sale_doc_status)), events = update)
- `merx.convention_registry` (kind = business)
- `merx.frozen_registry` (kind = root, status_column = status, open_status = draft, parent_table = —, parent_column = —)
- `merx.frozen_transition` (from_status = confirmed, to_status = cancelled, mutable_columns = {cancellation_reason})
- `merx.frozen_transition` (from_status = confirmed, to_status = delivered, mutable_columns = —)
- `merx.frozen_transition` (from_status = delivered, to_status = cancelled, mutable_columns = {cancellation_reason})
- `merx.frozen_transition` (from_status = draft, to_status = confirmed, mutable_columns = —)

**Colonnes**

| colonne | type | non nul | défaut ou expression |
| --- | --- | --- | --- |
| `id` | `uuid` | oui | `gen_random_uuid()` |
| `doc_type` | `sale_doc_type` | oui | — |
| `doc_number` | `text` | non | — |
| `warehouse_id` | `uuid` | oui | `merx.default_warehouse_id()` |
| `status` | `sale_doc_status` | oui | `'draft'::sale_doc_status` |
| `subtotal` | `money_amount` | oui | `0` |
| `discount_total` | `money_amount` | oui | `0` |
| `total` | `money_amount` | oui | `0` |
| `notes` | `text` | non | — |
| `issued_at` | `timestamp with time zone` | non | — |
| `cancellation_reason` | `text` | non | — |
| `tenant_id` | `uuid` | oui | `merx.current_tenant_id()` |
| `created_at` | `timestamp with time zone` | oui | `now()` |
| `updated_at` | `timestamp with time zone` | oui | `now()` |
| `created_by` | `uuid` | non | `merx.current_app_user()` |
| `device_id` | `uuid` | oui | — |
| `source_document_id` | `uuid` | non | — |

**Contraintes**

| nom | genre | définition |
| --- | --- | --- |
| `sale_document_amounts_not_negative` | check | `CHECK ((((subtotal)::numeric >= (0)::numeric) AND ((discount_total)::numeric >= (0)::numeric) AND ((total)::numeric >= (0)::numeric)))` |
| `sale_document_cancellation_reason` | check | `CHECK (((status <> 'cancelled'::sale_doc_status) OR (btrim(COALESCE(cancellation_reason, ''::text)) <> ''::text)))` |
| `sale_document_created_by_fkey` | clé étrangère | `FOREIGN KEY (tenant_id, created_by) REFERENCES app_user(tenant_id, id)` |
| `sale_document_device_id_fkey` | clé étrangère | `FOREIGN KEY (tenant_id, device_id) REFERENCES device(tenant_id, id)` |
| `sale_document_issued_at_when_numbered` | check | `CHECK (((status = 'draft'::sale_doc_status) = (issued_at IS NULL)))` |
| `sale_document_number_when_numbered` | check | `CHECK (((status = 'draft'::sale_doc_status) = (doc_number IS NULL)))` |
| `sale_document_pkey` | clé primaire | `PRIMARY KEY (id)` |
| `sale_document_return_has_source` | check | `CHECK (((doc_type <> 'return'::sale_doc_type) OR (source_document_id IS NOT NULL)))` |
| `sale_document_source_document_id_fkey` | clé étrangère | `FOREIGN KEY (tenant_id, source_document_id) REFERENCES sale_document(tenant_id, id)` |
| `sale_document_tenant_id_fkey` | clé étrangère | `FOREIGN KEY (tenant_id) REFERENCES tenant(id)` |
| `sale_document_tenant_id_id_key` | unicité | `UNIQUE (tenant_id, id)` |
| `sale_document_total_consistent` | check | `CHECK (((total)::numeric = ((subtotal)::numeric - (discount_total)::numeric)))` |
| `sale_document_warehouse_id_fkey` | clé étrangère | `FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouse(tenant_id, id)` |

**Index** (hors ceux qui servent une contrainte)

| nom | définition |
| --- | --- |
| `sale_document_number_per_tenant` | `CREATE UNIQUE INDEX sale_document_number_per_tenant ON public.sale_document USING btree (tenant_id, doc_number) WHERE (doc_number IS NOT NULL)` |
| `sale_document_source` | `CREATE INDEX sale_document_source ON public.sale_document USING btree (tenant_id, source_document_id) WHERE (source_document_id IS NOT NULL)` |
| `sale_document_tenant_id_idx` | `CREATE INDEX sale_document_tenant_id_idx ON public.sale_document USING btree (tenant_id)` |
| `sale_document_tenant_recent` | `CREATE INDEX sale_document_tenant_recent ON public.sale_document USING btree (tenant_id, COALESCE(issued_at, created_at) DESC)` |

**Policies**

| nom | genre | opérations | rôles | using | with check |
| --- | --- | --- | --- | --- | --- |
| `super_admin_all` | permissive | les quatre opérations | `authenticated` | `merx.is_super_admin()` | `merx.is_super_admin()` |
| `tenant_isolation` | permissive | les quatre opérations | `authenticated` | `(tenant_id = merx.current_tenant_id())` | `(tenant_id = merx.current_tenant_id())` |

**Triggers**

| nom | moment | événements | portée | condition | fonction |
| --- | --- | --- | --- | --- | --- |
| `advance_document_sequence` | AFTER | INSERT OR UPDATE | ligne | — | `merx.advance_document_sequence` |
| `audit_row_change` | AFTER | UPDATE | ligne | `((old.status IS DISTINCT FROM new.status) AND (new.status = 'cancelled'::sale_doc_status))` | `merx.audit_row_change` |
| `reject_frozen_birth` | BEFORE | INSERT | ligne | — | `merx.reject_frozen_birth` |
| `reject_frozen_delete` | BEFORE | DELETE | ligne | — | `merx.reject_frozen_delete` |
| `reject_frozen_truncate` | BEFORE | TRUNCATE | instruction | — | `merx.reject_frozen_truncate` |
| `reject_frozen_update` | BEFORE | UPDATE | ligne | — | `merx.reject_frozen_update` |
| `require_cancel_capability` | BEFORE | UPDATE | ligne | `((old.status IS DISTINCT FROM new.status) AND (new.status = 'cancelled'::sale_doc_status))` | `merx.require_cancel_capability` |
| `require_consistent_totals` | BEFORE | UPDATE | ligne | `((old.status = 'draft'::sale_doc_status) AND (new.status = 'confirmed'::sale_doc_status))` | `merx.require_consistent_totals` |
| `require_document_number_shape` | BEFORE | INSERT OR UPDATE | ligne | — | `merx.require_document_number_shape` |
| `require_no_active_return` | BEFORE | UPDATE | ligne | `((old.status IS DISTINCT FROM new.status) AND (new.status = 'cancelled'::sale_doc_status) AND (new.doc_type = 'delivery_note'::sale_doc_type))` | `merx.require_no_active_return` |
| `require_returnable_quantity` | BEFORE | UPDATE | ligne | `((old.status = 'draft'::sale_doc_status) AND (new.status = 'confirmed'::sale_doc_status) AND (new.doc_type = 'return'::sale_doc_type))` | `merx.require_returnable_quantity` |
| `require_transformation_shape` | BEFORE | INSERT | ligne | `(new.source_document_id IS NOT NULL)` | `merx.require_transformation_shape` |
| `reverse_sale_movements` | AFTER | UPDATE | ligne | `((old.status IS DISTINCT FROM new.status) AND (new.status = 'cancelled'::sale_doc_status))` | `merx.reverse_sale_movements` |
| `set_updated_at` | BEFORE | UPDATE | ligne | — | `merx.set_updated_at` |
| `write_return_movements` | AFTER | UPDATE | ligne | `((old.status = 'draft'::sale_doc_status) AND (new.status = 'confirmed'::sale_doc_status) AND (new.doc_type = 'return'::sale_doc_type))` | `merx.write_return_movements` |
| `write_sale_movements` | AFTER | UPDATE | ligne | `((old.status = 'draft'::sale_doc_status) AND (new.status = 'confirmed'::sale_doc_status) AND (new.doc_type = 'delivery_note'::sale_doc_type))` | `merx.write_sale_movements` |

### `sale_line`

> Une ligne de vente. Pointe sur une variante, jamais sur un produit — SPEC § 2.3. Figée avec son document : seul un brouillon reçoit, change ou perd des lignes. RÈGLE M3-3 ; E4-01.

RLS activée et **forcée**.

**Registres**

- `merx.audited_registry` (action = price_override, columns = {variant_id, quantity, overridden_price, unit_price}, row_condition = (new.overridden_price IS NOT NULL), events = insert or update)
- `merx.convention_registry` (kind = business)
- `merx.frozen_registry` (kind = child, status_column = —, open_status = —, parent_table = sale_document, parent_column = sale_document_id)

**Colonnes**

| colonne | type | non nul | défaut ou expression |
| --- | --- | --- | --- |
| `id` | `uuid` | oui | `gen_random_uuid()` |
| `sale_document_id` | `uuid` | oui | — |
| `variant_id` | `uuid` | oui | — |
| `quantity` | `quantity` | oui | — |
| `unit_price` | `money_amount` | oui | — |
| `price_source` | `price_source` | oui | `'auto'::price_source` |
| `line_discount` | `money_amount` | oui | `0` |
| `tenant_id` | `uuid` | oui | `merx.current_tenant_id()` |
| `created_at` | `timestamp with time zone` | oui | `now()` |
| `updated_at` | `timestamp with time zone` | oui | `now()` |
| `created_by` | `uuid` | non | `merx.current_app_user()` |
| `device_id` | `uuid` | non | — |
| `line_total` | `money_amount` | non | engendrée : `(round(((quantity)::numeric * (unit_price)::numeric), 2) - (line_discount)::numeric)` |
| `overridden_price` | `money_amount` | non | — |

**Contraintes**

| nom | genre | définition |
| --- | --- | --- |
| `sale_line_amounts_not_negative` | check | `CHECK ((((unit_price)::numeric >= (0)::numeric) AND ((line_discount)::numeric >= (0)::numeric) AND ((line_total)::numeric >= (0)::numeric)))` |
| `sale_line_created_by_fkey` | clé étrangère | `FOREIGN KEY (tenant_id, created_by) REFERENCES app_user(tenant_id, id)` |
| `sale_line_override_shape` | check | `CHECK (((overridden_price IS NULL) OR ((price_source = 'manual'::price_source) AND ((overridden_price)::numeric <> (unit_price)::numeric))))` |
| `sale_line_pkey` | clé primaire | `PRIMARY KEY (id)` |
| `sale_line_quantity_positive` | check | `CHECK (((quantity)::numeric > (0)::numeric))` |
| `sale_line_sale_document_id_fkey` | clé étrangère | `FOREIGN KEY (tenant_id, sale_document_id) REFERENCES sale_document(tenant_id, id) ON DELETE CASCADE` |
| `sale_line_tenant_id_fkey` | clé étrangère | `FOREIGN KEY (tenant_id) REFERENCES tenant(id)` |
| `sale_line_variant_id_fkey` | clé étrangère | `FOREIGN KEY (tenant_id, variant_id) REFERENCES variant(tenant_id, id)` |

**Index** (hors ceux qui servent une contrainte)

| nom | définition |
| --- | --- |
| `sale_line_document` | `CREATE INDEX sale_line_document ON public.sale_line USING btree (tenant_id, sale_document_id)` |
| `sale_line_tenant_id_idx` | `CREATE INDEX sale_line_tenant_id_idx ON public.sale_line USING btree (tenant_id)` |

**Policies**

| nom | genre | opérations | rôles | using | with check |
| --- | --- | --- | --- | --- | --- |
| `super_admin_all` | permissive | les quatre opérations | `authenticated` | `merx.is_super_admin()` | `merx.is_super_admin()` |
| `tenant_isolation` | permissive | les quatre opérations | `authenticated` | `(tenant_id = merx.current_tenant_id())` | `(tenant_id = merx.current_tenant_id())` |

**Triggers**

| nom | moment | événements | portée | condition | fonction |
| --- | --- | --- | --- | --- | --- |
| `audit_row_change` | AFTER | INSERT OR UPDATE | ligne | `(new.overridden_price IS NOT NULL)` | `merx.audit_row_change` |
| `reject_frozen_child_write` | BEFORE | INSERT OR DELETE OR UPDATE | ligne | — | `merx.reject_frozen_child_write` |
| `reject_frozen_truncate` | BEFORE | TRUNCATE | instruction | — | `merx.reject_frozen_truncate` |
| `require_floor_price` | BEFORE | INSERT OR UPDATE | ligne | — | `merx.require_floor_price` |
| `set_updated_at` | BEFORE | UPDATE | ligne | — | `merx.set_updated_at` |

### `stock_level`

> La quantité en stock d'une variante, agrégat des mouvements. Jamais écrit directement — RÈGLE M2-1. SPEC § 7 M2 ; E3-01.

RLS activée et **forcée**.

**Registres**

- `merx.convention_registry` (kind = business)
- `merx.derived_registry` (source_table = stock_movement, writer_function = maintain_stock_level)

**Colonnes**

| colonne | type | non nul | défaut ou expression |
| --- | --- | --- | --- |
| `id` | `uuid` | oui | `gen_random_uuid()` |
| `variant_id` | `uuid` | oui | — |
| `warehouse_id` | `uuid` | oui | — |
| `quantity` | `quantity` | oui | `0` |
| `tenant_id` | `uuid` | oui | `merx.current_tenant_id()` |
| `created_at` | `timestamp with time zone` | oui | `now()` |
| `updated_at` | `timestamp with time zone` | oui | `now()` |
| `created_by` | `uuid` | non | — |
| `device_id` | `uuid` | non | — |
| `last_movement_at` | `timestamp with time zone` | non | — |

**Contraintes**

| nom | genre | définition |
| --- | --- | --- |
| `stock_level_created_by_fkey` | clé étrangère | `FOREIGN KEY (tenant_id, created_by) REFERENCES app_user(tenant_id, id)` |
| `stock_level_pkey` | clé primaire | `PRIMARY KEY (id)` |
| `stock_level_tenant_id_fkey` | clé étrangère | `FOREIGN KEY (tenant_id) REFERENCES tenant(id)` |
| `stock_level_variant_id_fkey` | clé étrangère | `FOREIGN KEY (tenant_id, variant_id) REFERENCES variant(tenant_id, id) ON DELETE CASCADE` |
| `stock_level_warehouse_id_fkey` | clé étrangère | `FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouse(tenant_id, id)` |

**Index** (hors ceux qui servent une contrainte)

| nom | définition |
| --- | --- |
| `stock_level_negative` | `CREATE INDEX stock_level_negative ON public.stock_level USING btree (tenant_id, quantity) WHERE ((quantity)::numeric < (0)::numeric)` |
| `stock_level_tenant_id_idx` | `CREATE INDEX stock_level_tenant_id_idx ON public.stock_level USING btree (tenant_id)` |
| `stock_level_variant_warehouse` | `CREATE UNIQUE INDEX stock_level_variant_warehouse ON public.stock_level USING btree (variant_id, warehouse_id)` |
| `stock_level_zero` | `CREATE INDEX stock_level_zero ON public.stock_level USING btree (tenant_id) WHERE ((quantity)::numeric = (0)::numeric)` |

**Policies**

| nom | genre | opérations | rôles | using | with check |
| --- | --- | --- | --- | --- | --- |
| `super_admin_all` | permissive | les quatre opérations | `authenticated` | `merx.is_super_admin()` | `merx.is_super_admin()` |
| `tenant_isolation` | permissive | les quatre opérations | `authenticated` | `(tenant_id = merx.current_tenant_id())` | `(tenant_id = merx.current_tenant_id())` |

**Triggers**

| nom | moment | événements | portée | condition | fonction |
| --- | --- | --- | --- | --- | --- |
| `reject_derived_insert` | AFTER | INSERT | ligne | — | `merx.reject_derived_write` |
| `reject_derived_truncate` | BEFORE | TRUNCATE | instruction | — | `merx.reject_derived_truncate` |
| `reject_derived_write` | BEFORE | DELETE OR UPDATE | ligne | — | `merx.reject_derived_write` |
| `set_updated_at` | BEFORE | UPDATE | ligne | — | `merx.set_updated_at` |

### `stock_movement`

> Tout ce qui fait bouger une quantité. En ajout seul : une erreur se corrige par un mouvement inverse. SPEC § 7 M2, RÈGLE M2-2 ; E3-01.

RLS activée et **forcée**.

**Registres**

- `merx.append_only_registry` (write_path = restricted)
- `merx.audited_registry` (action = stock_adjustment, columns = {variant_id, quantity, note}, row_condition = (new.movement_type = 'adjustment'::public.stock_movement_type), events = insert)
- `merx.column_capability_registry` (column_name = movement_type, resolver_function = can_move_stock)
- `merx.convention_registry` (kind = business)

**Colonnes**

| colonne | type | non nul | défaut ou expression |
| --- | --- | --- | --- |
| `id` | `uuid` | oui | `gen_random_uuid()` |
| `variant_id` | `uuid` | oui | — |
| `warehouse_id` | `uuid` | oui | — |
| `movement_type` | `stock_movement_type` | oui | — |
| `quantity` | `quantity` | oui | — |
| `source_type` | `stock_source_type` | non | — |
| `source_id` | `uuid` | non | — |
| `note` | `text` | non | — |
| `tenant_id` | `uuid` | oui | `merx.current_tenant_id()` |
| `created_at` | `timestamp with time zone` | oui | `now()` |
| `updated_at` | `timestamp with time zone` | oui | `now()` |
| `created_by` | `uuid` | non | `merx.current_app_user()` |
| `device_id` | `uuid` | non | — |

**Contraintes**

| nom | genre | définition |
| --- | --- | --- |
| `stock_movement_adjustment_reason` | check | `CHECK (((movement_type <> 'adjustment'::stock_movement_type) OR (btrim(COALESCE(note, ''::text)) <> ''::text)))` |
| `stock_movement_created_by_fkey` | clé étrangère | `FOREIGN KEY (tenant_id, created_by) REFERENCES app_user(tenant_id, id)` |
| `stock_movement_pkey` | clé primaire | `PRIMARY KEY (id)` |
| `stock_movement_quantity_check` | check | `CHECK (((quantity)::numeric <> (0)::numeric))` |
| `stock_movement_source_complete` | check | `CHECK (((source_type IS NULL) = (source_id IS NULL)))` |
| `stock_movement_tenant_id_fkey` | clé étrangère | `FOREIGN KEY (tenant_id) REFERENCES tenant(id)` |
| `stock_movement_variant_id_fkey` | clé étrangère | `FOREIGN KEY (tenant_id, variant_id) REFERENCES variant(tenant_id, id)` |
| `stock_movement_warehouse_id_fkey` | clé étrangère | `FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouse(tenant_id, id)` |

**Index** (hors ceux qui servent une contrainte)

| nom | définition |
| --- | --- |
| `stock_movement_source` | `CREATE INDEX stock_movement_source ON public.stock_movement USING btree (tenant_id, source_id) WHERE (source_id IS NOT NULL)` |
| `stock_movement_tenant_id_idx` | `CREATE INDEX stock_movement_tenant_id_idx ON public.stock_movement USING btree (tenant_id)` |
| `stock_movement_variant_created_at` | `CREATE INDEX stock_movement_variant_created_at ON public.stock_movement USING btree (tenant_id, variant_id, created_at DESC)` |

**Policies**

| nom | genre | opérations | rôles | using | with check |
| --- | --- | --- | --- | --- | --- |
| `column_capability_insert` | restrictive | insert | `authenticated` | — | `merx.can_move_stock(movement_type)` |
| `super_admin_all` | permissive | les quatre opérations | `authenticated` | `merx.is_super_admin()` | `merx.is_super_admin()` |
| `tenant_isolation` | permissive | les quatre opérations | `authenticated` | `(tenant_id = merx.current_tenant_id())` | `(tenant_id = merx.current_tenant_id())` |

**Triggers**

| nom | moment | événements | portée | condition | fonction |
| --- | --- | --- | --- | --- | --- |
| `audit_row_change` | AFTER | INSERT | ligne | `(new.movement_type = 'adjustment'::stock_movement_type)` | `merx.audit_row_change` |
| `maintain_stock_level` | AFTER | INSERT | ligne | — | `merx.maintain_stock_level` |
| `reject_row_mutation` | BEFORE | DELETE OR UPDATE | ligne | — | `merx.reject_row_mutation` |
| `reject_truncate` | BEFORE | TRUNCATE | instruction | — | `merx.reject_truncate` |
| `require_cancellation_origin` | AFTER | INSERT | ligne | `(new.movement_type = 'sale_cancellation'::stock_movement_type)` | `merx.require_cancellation_origin` |
| `require_open_movement_type` | AFTER | INSERT | ligne | — | `merx.require_open_movement_type` |
| `require_return_origin` | AFTER | INSERT | ligne | `(new.movement_type = 'return'::stock_movement_type)` | `merx.require_return_origin` |
| `require_sale_origin` | AFTER | INSERT | ligne | `(new.movement_type = 'sale'::stock_movement_type)` | `merx.require_sale_origin` |
| `set_updated_at` | BEFORE | UPDATE | ligne | — | `merx.set_updated_at` |

### `tenant`

> Un commerce. Unité d'isolation de toute la base. SPEC § 2.1, § 9 M8.

RLS activée et **forcée**.

**Registres**

- `merx.convention_registry` (kind = reference)

**Colonnes**

| colonne | type | non nul | défaut ou expression |
| --- | --- | --- | --- |
| `id` | `uuid` | oui | `gen_random_uuid()` |
| `business_name` | `text` | oui | — |
| `owner_name` | `text` | non | — |
| `phone` | `text` | non | — |
| `city` | `text` | non | — |
| `subscription_status` | `text` | oui | `'trial'::text` |
| `trial_ends_at` | `timestamp with time zone` | non | — |
| `tenant_id` | `uuid` | oui | `merx.current_tenant_id()` |
| `created_at` | `timestamp with time zone` | oui | `now()` |
| `updated_at` | `timestamp with time zone` | oui | `now()` |
| `created_by` | `uuid` | non | — |
| `device_id` | `uuid` | non | — |
| `deleted_at` | `timestamp with time zone` | non | — |

**Contraintes**

| nom | genre | définition |
| --- | --- | --- |
| `tenant_created_by_fkey` | clé étrangère | `FOREIGN KEY (tenant_id, created_by) REFERENCES app_user(tenant_id, id)` |
| `tenant_id_is_self` | check | `CHECK ((tenant_id = id))` |
| `tenant_pkey` | clé primaire | `PRIMARY KEY (id)` |
| `tenant_subscription_status_check` | check | `CHECK ((subscription_status = ANY (ARRAY['trial'::text, 'active'::text, 'suspended'::text, 'cancelled'::text])))` |
| `tenant_tenant_id_fkey` | clé étrangère | `FOREIGN KEY (tenant_id) REFERENCES tenant(id)` |

**Index** (hors ceux qui servent une contrainte)

| nom | définition |
| --- | --- |
| `tenant_tenant_id_idx` | `CREATE INDEX tenant_tenant_id_idx ON public.tenant USING btree (tenant_id)` |

**Policies**

| nom | genre | opérations | rôles | using | with check |
| --- | --- | --- | --- | --- | --- |
| `super_admin_all` | permissive | les quatre opérations | `authenticated` | `merx.is_super_admin()` | `merx.is_super_admin()` |
| `tenant_isolation` | permissive | les quatre opérations | `authenticated` | `(tenant_id = merx.current_tenant_id())` | `(tenant_id = merx.current_tenant_id())` |

**Triggers**

| nom | moment | événements | portée | condition | fonction |
| --- | --- | --- | --- | --- | --- |
| `open_default_warehouse` | AFTER | INSERT | ligne | — | `merx.open_default_warehouse` |
| `set_updated_at` | BEFORE | UPDATE | ligne | — | `merx.set_updated_at` |
| `tenant_self_reference` | BEFORE | INSERT | ligne | — | `merx.tenant_is_its_own_tenant` |

### `tenant_setting`

> Les réglages d'un commerce, une ligne par clé, toujours toutes présentes. Lue par tout le commerce, écrite par le patron seul. SPEC § 9 M8 ; E1-05.

RLS activée et **forcée**.

**Registres**

- `merx.convention_registry` (kind = business)
- `merx.write_capability_registry` (capability = manage_settings)

**Colonnes**

| colonne | type | non nul | défaut ou expression |
| --- | --- | --- | --- |
| `id` | `uuid` | oui | `gen_random_uuid()` |
| `key` | `setting_key` | oui | — |
| `value` | `jsonb` | oui | — |
| `tenant_id` | `uuid` | oui | `merx.current_tenant_id()` |
| `created_at` | `timestamp with time zone` | oui | `now()` |
| `updated_at` | `timestamp with time zone` | oui | `now()` |
| `created_by` | `uuid` | non | — |
| `device_id` | `uuid` | non | — |

**Contraintes**

| nom | genre | définition |
| --- | --- | --- |
| `tenant_setting_created_by_fkey` | clé étrangère | `FOREIGN KEY (tenant_id, created_by) REFERENCES app_user(tenant_id, id)` |
| `tenant_setting_pkey` | clé primaire | `PRIMARY KEY (id)` |
| `tenant_setting_tenant_id_fkey` | clé étrangère | `FOREIGN KEY (tenant_id) REFERENCES tenant(id)` |

**Index** (hors ceux qui servent une contrainte)

| nom | définition |
| --- | --- |
| `tenant_setting_key_per_tenant` | `CREATE UNIQUE INDEX tenant_setting_key_per_tenant ON public.tenant_setting USING btree (tenant_id, key)` |
| `tenant_setting_tenant_id_idx` | `CREATE INDEX tenant_setting_tenant_id_idx ON public.tenant_setting USING btree (tenant_id)` |

**Policies**

| nom | genre | opérations | rôles | using | with check |
| --- | --- | --- | --- | --- | --- |
| `super_admin_all` | permissive | les quatre opérations | `authenticated` | `merx.is_super_admin()` | `merx.is_super_admin()` |
| `tenant_isolation` | permissive | les quatre opérations | `authenticated` | `(tenant_id = merx.current_tenant_id())` | `(tenant_id = merx.current_tenant_id())` |
| `write_capability_delete` | restrictive | delete | `authenticated` | `merx.can('manage_settings'::text)` | — |
| `write_capability_insert` | restrictive | insert | `authenticated` | — | `merx.can('manage_settings'::text)` |
| `write_capability_update` | restrictive | update | `authenticated` | `merx.can('manage_settings'::text)` | `merx.can('manage_settings'::text)` |

**Triggers**

| nom | moment | événements | portée | condition | fonction |
| --- | --- | --- | --- | --- | --- |
| `set_updated_at` | BEFORE | UPDATE | ligne | — | `merx.set_updated_at` |

### `variant`

> Ce qui se stocke, se prix et se vend. Tout produit en a au moins une ; la variante par défaut porte l'identifiant de son produit. SPEC § 2.3, § 6.

RLS activée et **forcée**.

**Registres**

- `merx.convention_registry` (kind = reference)
- `merx.write_capability_registry` (capability = manage_product)

**Colonnes**

| colonne | type | non nul | défaut ou expression |
| --- | --- | --- | --- |
| `id` | `uuid` | oui | `gen_random_uuid()` |
| `product_id` | `uuid` | oui | — |
| `sku` | `text` | non | — |
| `barcode` | `text` | non | — |
| `attributes` | `jsonb` | oui | `'{}'::jsonb` |
| `floor_price` | `money_amount` | non | — |
| `is_default` | `boolean` | oui | `false` |
| `is_active` | `boolean` | oui | `true` |
| `tenant_id` | `uuid` | oui | `merx.current_tenant_id()` |
| `created_at` | `timestamp with time zone` | oui | `now()` |
| `updated_at` | `timestamp with time zone` | oui | `now()` |
| `created_by` | `uuid` | non | — |
| `device_id` | `uuid` | non | — |
| `deleted_at` | `timestamp with time zone` | non | — |
| `search_sku` | `text` | non | engendrée : `merx.search_fold(sku)` |
| `search_barcode` | `text` | non | engendrée : `merx.search_fold(barcode)` |
| `sku_printed_at` | `timestamp with time zone` | non | — |

**Contraintes**

| nom | genre | définition |
| --- | --- | --- |
| `variant_created_by_fkey` | clé étrangère | `FOREIGN KEY (tenant_id, created_by) REFERENCES app_user(tenant_id, id)` |
| `variant_pkey` | clé primaire | `PRIMARY KEY (id)` |
| `variant_product_id_fkey` | clé étrangère | `FOREIGN KEY (tenant_id, product_id) REFERENCES product(tenant_id, id) ON DELETE CASCADE` |
| `variant_tenant_id_fkey` | clé étrangère | `FOREIGN KEY (tenant_id) REFERENCES tenant(id)` |
| `variant_tenant_id_id_key` | unicité | `UNIQUE (tenant_id, id)` |

**Index** (hors ceux qui servent une contrainte)

| nom | définition |
| --- | --- |
| `variant_barcode_per_tenant` | `CREATE UNIQUE INDEX variant_barcode_per_tenant ON public.variant USING btree (tenant_id, lower(barcode)) WHERE ((deleted_at IS NULL) AND (barcode IS NOT NULL))` |
| `variant_one_default_per_product` | `CREATE UNIQUE INDEX variant_one_default_per_product ON public.variant USING btree (product_id) WHERE is_default` |
| `variant_product` | `CREATE INDEX variant_product ON public.variant USING btree (tenant_id, product_id)` |
| `variant_search` | `CREATE INDEX variant_search ON public.variant USING gin (tenant_id, (((search_sku \|\| ' '::text) \|\| search_barcode)) gin_trgm_ops) WITH (fastupdate=off)` |
| `variant_sku_per_tenant` | `CREATE UNIQUE INDEX variant_sku_per_tenant ON public.variant USING btree (tenant_id, lower(sku)) WHERE ((deleted_at IS NULL) AND (sku IS NOT NULL))` |
| `variant_tenant_id_idx` | `CREATE INDEX variant_tenant_id_idx ON public.variant USING btree (tenant_id)` |

**Policies**

| nom | genre | opérations | rôles | using | with check |
| --- | --- | --- | --- | --- | --- |
| `super_admin_all` | permissive | les quatre opérations | `authenticated` | `merx.is_super_admin()` | `merx.is_super_admin()` |
| `tenant_isolation` | permissive | les quatre opérations | `authenticated` | `(tenant_id = merx.current_tenant_id())` | `(tenant_id = merx.current_tenant_id())` |
| `write_capability_delete` | restrictive | delete | `authenticated` | `merx.can('manage_product'::text)` | — |
| `write_capability_insert` | restrictive | insert | `authenticated` | — | `merx.can('manage_product'::text)` |
| `write_capability_update` | restrictive | update | `authenticated` | `merx.can('manage_product'::text)` | `merx.can('manage_product'::text)` |

**Triggers**

| nom | moment | événements | portée | condition | fonction |
| --- | --- | --- | --- | --- | --- |
| `create_base_price_break` | AFTER | INSERT | ligne | — | `merx.create_base_price_break` |
| `keep_one_variant` | BEFORE | DELETE | ligne | — | `merx.keep_one_variant` |
| `normalize_sku` | BEFORE | INSERT OR UPDATE | ligne | — | `merx.normalize_variant_sku` |
| `open_stock_level` | AFTER | INSERT | ligne | — | `merx.maintain_stock_level` |
| `pin_variant_product` | BEFORE | UPDATE | ligne | — | `merx.pin_variant_product` |
| `protect_printed_sku` | BEFORE | UPDATE | ligne | — | `merx.protect_printed_sku` |
| `set_updated_at` | BEFORE | UPDATE | ligne | — | `merx.set_updated_at` |

### `variant_cost`

> Prix d'achat d'une variante, une ligne au plus. Relation restreinte par view_cost : un worker n'en lit aucune ligne, et la clé cost_price n'apparaît dans aucune réponse qui lui est faite. SPEC § 3, § 6. Pas de restriction d'écriture (apply_write_capability_restriction) en plus de view_cost, et ce n'est pas un oubli : elle refuserait l'employé avec le même 42501 que la policy view_cost, dont le with check couvre déjà l'écriture ; aucun test ne pourrait la faire tomber seule, elle n'existerait que pour la forme (CLAUDE.md, E1-02). Ne pas l'ajouter sans une capacité distincte et un test qui la distingue.

RLS activée et **forcée**.

**Registres**

- `merx.audited_registry` (action = purchase_price_change, columns = {variant_id, cost_price}, row_condition = —, events = insert or update or delete)
- `merx.confidential_registry` (capability = view_cost)
- `merx.convention_registry` (kind = business)

**Colonnes**

| colonne | type | non nul | défaut ou expression |
| --- | --- | --- | --- |
| `id` | `uuid` | oui | `gen_random_uuid()` |
| `variant_id` | `uuid` | oui | — |
| `cost_price` | `money_amount` | oui | — |
| `tenant_id` | `uuid` | oui | `merx.current_tenant_id()` |
| `created_at` | `timestamp with time zone` | oui | `now()` |
| `updated_at` | `timestamp with time zone` | oui | `now()` |
| `created_by` | `uuid` | non | — |
| `device_id` | `uuid` | non | — |

**Contraintes**

| nom | genre | définition |
| --- | --- | --- |
| `variant_cost_cost_price_check` | check | `CHECK (((cost_price)::numeric >= (0)::numeric))` |
| `variant_cost_created_by_fkey` | clé étrangère | `FOREIGN KEY (tenant_id, created_by) REFERENCES app_user(tenant_id, id)` |
| `variant_cost_one_per_variant` | unicité | `UNIQUE (variant_id)` |
| `variant_cost_pkey` | clé primaire | `PRIMARY KEY (id)` |
| `variant_cost_tenant_id_fkey` | clé étrangère | `FOREIGN KEY (tenant_id) REFERENCES tenant(id)` |
| `variant_cost_variant_id_fkey` | clé étrangère | `FOREIGN KEY (tenant_id, variant_id) REFERENCES variant(tenant_id, id) ON DELETE CASCADE` |

**Index** (hors ceux qui servent une contrainte)

| nom | définition |
| --- | --- |
| `variant_cost_tenant_id_idx` | `CREATE INDEX variant_cost_tenant_id_idx ON public.variant_cost USING btree (tenant_id)` |

**Policies**

| nom | genre | opérations | rôles | using | with check |
| --- | --- | --- | --- | --- | --- |
| `capability_restriction` | restrictive | les quatre opérations | `authenticated` | `merx.can('view_cost'::text)` | `merx.can('view_cost'::text)` |
| `super_admin_all` | permissive | les quatre opérations | `authenticated` | `merx.is_super_admin()` | `merx.is_super_admin()` |
| `tenant_isolation` | permissive | les quatre opérations | `authenticated` | `(tenant_id = merx.current_tenant_id())` | `(tenant_id = merx.current_tenant_id())` |

**Triggers**

| nom | moment | événements | portée | condition | fonction |
| --- | --- | --- | --- | --- | --- |
| `audit_row_change` | AFTER | INSERT OR DELETE OR UPDATE | ligne | — | `merx.audit_row_change` |
| `set_updated_at` | BEFORE | UPDATE | ligne | — | `merx.set_updated_at` |

### `warehouse`

> Dépôt. Une ligne par commerce, créée automatiquement, jamais exposée. SPEC § 2.4, § 7 M2.

RLS activée et **forcée**.

**Registres**

- `merx.convention_registry` (kind = reference)

**Colonnes**

| colonne | type | non nul | défaut ou expression |
| --- | --- | --- | --- |
| `id` | `uuid` | oui | `gen_random_uuid()` |
| `name` | `text` | oui | — |
| `is_default` | `boolean` | oui | `true` |
| `tenant_id` | `uuid` | oui | `merx.current_tenant_id()` |
| `created_at` | `timestamp with time zone` | oui | `now()` |
| `updated_at` | `timestamp with time zone` | oui | `now()` |
| `created_by` | `uuid` | non | — |
| `device_id` | `uuid` | non | — |
| `deleted_at` | `timestamp with time zone` | non | — |

**Contraintes**

| nom | genre | définition |
| --- | --- | --- |
| `warehouse_created_by_fkey` | clé étrangère | `FOREIGN KEY (tenant_id, created_by) REFERENCES app_user(tenant_id, id)` |
| `warehouse_pkey` | clé primaire | `PRIMARY KEY (id)` |
| `warehouse_tenant_id_fkey` | clé étrangère | `FOREIGN KEY (tenant_id) REFERENCES tenant(id)` |
| `warehouse_tenant_id_id_key` | unicité | `UNIQUE (tenant_id, id)` |

**Index** (hors ceux qui servent une contrainte)

| nom | définition |
| --- | --- |
| `warehouse_one_default_per_tenant` | `CREATE UNIQUE INDEX warehouse_one_default_per_tenant ON public.warehouse USING btree (tenant_id) WHERE (is_default AND (deleted_at IS NULL))` |
| `warehouse_tenant_id_idx` | `CREATE INDEX warehouse_tenant_id_idx ON public.warehouse USING btree (tenant_id)` |

**Policies**

| nom | genre | opérations | rôles | using | with check |
| --- | --- | --- | --- | --- | --- |
| `super_admin_all` | permissive | les quatre opérations | `authenticated` | `merx.is_super_admin()` | `merx.is_super_admin()` |
| `tenant_isolation` | permissive | les quatre opérations | `authenticated` | `(tenant_id = merx.current_tenant_id())` | `(tenant_id = merx.current_tenant_id())` |

**Triggers**

| nom | moment | événements | portée | condition | fonction |
| --- | --- | --- | --- | --- | --- |
| `set_updated_at` | BEFORE | UPDATE | ligne | — | `merx.set_updated_at` |

---

## Fonctions

« Garde § 2.1 » est la forme déclarée à `merx.rls_exception_registry`, que
`conventions.ts` contrôle **au corps** de la fonction : inscrire une forme sans
l'avoir ne passe pas. Une fonction `definer` sans garde inscrit est une
infraction, pas une colonne vide.

### Schéma `public`

| fonction | rend | langage | volatilité | sécurité | réglages | garde § 2.1 |
| --- | --- | --- | --- | --- | --- | --- |
| `can_create_tenant()` | `boolean` | sql | stable | **definer** | {search_path=""} | — |
| `can_manage_users()` | `boolean` | sql | stable | **definer** | {search_path=""} | — |
| `create_tenant(business_name text, owner_name text, phone text, city text, auth_user_id uuid)` | `uuid` | plpgsql | volatile | **definer** | {search_path=""} | `super_admin` |
| `create_worker(full_name text, phone text, auth_user_id uuid)` | `uuid` | plpgsql | volatile | **definer** | {search_path=""} | `current_tenant` |
| `import_products(rows jsonb)` | `jsonb` | plpgsql | volatile | invoker | {search_path=""} | — |
| `list_sale_documents(p_from timestamp with time zone, p_to timestamp with time zone, p_status sale_doc_status, p_doc_type sale_doc_type, p_device_id uuid, p_search text, p_document_id uuid, p_limit integer)` | `TABLE(id uuid, doc_type sale_doc_type, doc_number text, status sale_doc_status, subtotal money_amount, discount_total money_amount, total money_amount, notes text, cancellation_reason text, issued_at timestamp with time zone, created_at timestamp with time zone, sort_at timestamp with time zone, source_document_id uuid, device_id uuid, device_label text, device_prefix device_prefix, author_name text)` | plpgsql | stable | **definer** | {search_path="", plan_cache_mode=force_custom_plan} | `current_tenant` |
| `list_stock_movements(p_variant_id uuid, p_limit integer)` | `TABLE(id uuid, created_at timestamp with time zone, movement_type stock_movement_type, quantity quantity, source_type stock_source_type, source_id uuid, note text, author_name text)` | plpgsql | stable | **definer** | {search_path="", plan_cache_mode=force_custom_plan} | `current_tenant` |
| `register_device(device_key uuid, device_label text)` | `TABLE(id uuid, label text, prefix device_prefix, last_sync_at timestamp with time zone)` | plpgsql | volatile | **definer** | {search_path=""} | `current_tenant` |
| `search_products(q text)` | `TABLE(variant_id uuid, product_id uuid, name_fr text, name_ar text, code text, sku text, barcode text, photo_url text)` | plpgsql | stable | **definer** | {search_path="", plan_cache_mode=force_custom_plan, pg_trgm.word_similarity_threshold=0.4} | `current_tenant` |
| `set_user_active(target_user uuid, active boolean)` | `void` | plpgsql | volatile | **definer** | {search_path=""} | `current_tenant` |

### Schéma `merx`

| fonction | rend | langage | volatilité | sécurité | réglages | garde § 2.1 |
| --- | --- | --- | --- | --- | --- | --- |
| `advance_document_sequence()` | `trigger` | plpgsql | volatile | invoker | {search_path=""} | — |
| `allow_frozen_transition(target regclass, from_status text, to_status text, mutable_columns text[])` | `void` | plpgsql | volatile | invoker | — | — |
| `apply_append_only(target regclass, write_path text)` | `void` | plpgsql | volatile | invoker | — | — |
| `apply_audit(target regclass, audited_action audit_action, audited_columns text[], row_condition text, only_events text[])` | `void` | plpgsql | volatile | invoker | {search_path=""} | — |
| `apply_business_conventions(target regclass)` | `void` | plpgsql | volatile | invoker | — | — |
| `apply_capability_restriction(target regclass, required_capability text)` | `void` | plpgsql | volatile | invoker | — | — |
| `apply_column_capability_insert(target regclass, column_name text, resolver_function text)` | `void` | plpgsql | volatile | invoker | — | — |
| `apply_derived_from(target regclass, source text, writer_function text)` | `void` | plpgsql | volatile | invoker | — | — |
| `apply_frozen_child(target regclass, parent regclass, parent_column text)` | `void` | plpgsql | volatile | invoker | — | — |
| `apply_frozen_when(target regclass, status_column text, open_status text)` | `void` | plpgsql | volatile | invoker | — | — |
| `apply_reference_conventions(target regclass)` | `void` | plpgsql | volatile | invoker | — | — |
| `apply_tenant_isolation(target regclass)` | `void` | plpgsql | volatile | invoker | — | — |
| `apply_write_capability_restriction(target regclass, required_capability text)` | `void` | plpgsql | volatile | invoker | — | — |
| `audit_row_change()` | `trigger` | plpgsql | volatile | **definer** | {search_path=""} | — |
| `can(wanted text)` | `boolean` | sql | stable | **definer** | {search_path=""} | — |
| `can_move_stock(kind stock_movement_type)` | `boolean` | sql | stable | **definer** | {search_path=""} | — |
| `create_base_price_break()` | `trigger` | plpgsql | volatile | invoker | {search_path=""} | — |
| `create_default_variant()` | `trigger` | plpgsql | volatile | invoker | {search_path=""} | — |
| `current_app_user()` | `uuid` | sql | stable | **definer** | {search_path=""} | `auth_identity` |
| `current_tenant_id()` | `uuid` | sql | stable | invoker | {search_path=""} | — |
| `current_user_role()` | `user_role` | sql | stable | invoker | {search_path=""} | — |
| `custom_access_token(event jsonb)` | `jsonb` | plpgsql | volatile | **definer** | {search_path=""} | `auth_identity` |
| `default_warehouse_id()` | `uuid` | sql | stable | invoker | {search_path=""} | — |
| `doc_type_code(doc_type sale_doc_type)` | `text` | sql | immutable | invoker | {search_path=""} | — |
| `document_number_sequence(doc_number text)` | `integer` | sql | immutable | invoker | {search_path=""} | — |
| `document_number_year(issued_at timestamp with time zone)` | `smallint` | sql | stable | invoker | {search_path=""} | — |
| `follow_product_code()` | `trigger` | plpgsql | volatile | invoker | {search_path=""} | — |
| `is_super_admin()` | `boolean` | sql | stable | invoker | {search_path=""} | — |
| `keep_base_price_break()` | `trigger` | plpgsql | volatile | invoker | {search_path=""} | — |
| `keep_one_variant()` | `trigger` | plpgsql | volatile | invoker | {search_path=""} | — |
| `like_pattern(value text)` | `text` | sql | immutable | invoker | — | — |
| `log_audit(performed_action audit_action, target_entity_type text, target_entity_id uuid, state_before jsonb, state_after jsonb)` | `uuid` | plpgsql | volatile | **definer** | {search_path=""} | `current_tenant` |
| `maintain_stock_level()` | `trigger` | plpgsql | volatile | invoker | {search_path=""} | — |
| `next_device_prefix(target_tenant uuid)` | `device_prefix` | plpgsql | volatile | **definer** | {search_path=""} | `argument_tenant` |
| `normalize_product_code()` | `trigger` | plpgsql | volatile | invoker | {search_path=""} | — |
| `normalize_variant_sku()` | `trigger` | plpgsql | volatile | invoker | {search_path=""} | — |
| `open_default_warehouse()` | `trigger` | plpgsql | volatile | **definer** | {search_path=""} | `row_tenant` |
| `photo_product_id(object_name text)` | `uuid` | sql | immutable | invoker | {search_path=""} | — |
| `pin_base_price_break()` | `trigger` | plpgsql | volatile | invoker | {search_path=""} | — |
| `pin_variant_product()` | `trigger` | plpgsql | volatile | invoker | {search_path=""} | — |
| `propagate_product_deletion()` | `trigger` | plpgsql | volatile | invoker | {search_path=""} | — |
| `protect_own_role()` | `trigger` | plpgsql | volatile | invoker | {search_path=""} | — |
| `protect_printed_sku()` | `trigger` | plpgsql | volatile | invoker | {search_path=""} | — |
| `register_creation_form(target regclass, name_column text)` | `void` | plpgsql | volatile | invoker | — | — |
| `register_rls_exception(target regprocedure, guard merx.rls_exception_guard, justification text)` | `void` | plpgsql | volatile | invoker | {search_path=""} | — |
| `reject_derived_truncate()` | `trigger` | plpgsql | volatile | **definer** | {search_path=""} | — |
| `reject_derived_write()` | `trigger` | plpgsql | volatile | **definer** | {search_path=""} | — |
| `reject_frozen_birth()` | `trigger` | plpgsql | volatile | **definer** | {search_path=""} | — |
| `reject_frozen_child_write()` | `trigger` | plpgsql | volatile | invoker | {search_path=""} | — |
| `reject_frozen_delete()` | `trigger` | plpgsql | volatile | **definer** | {search_path=""} | — |
| `reject_frozen_truncate()` | `trigger` | plpgsql | volatile | invoker | {search_path=""} | — |
| `reject_frozen_update()` | `trigger` | plpgsql | volatile | **definer** | {search_path=""} | — |
| `reject_row_mutation()` | `trigger` | plpgsql | volatile | invoker | {search_path=""} | — |
| `reject_truncate()` | `trigger` | plpgsql | volatile | invoker | {search_path=""} | — |
| `require_cancel_capability()` | `trigger` | plpgsql | volatile | invoker | {search_path=""} | — |
| `require_cancellation_origin()` | `trigger` | plpgsql | volatile | invoker | {search_path=""} | — |
| `require_consistent_totals()` | `trigger` | plpgsql | volatile | **definer** | {search_path=""} | `row_tenant` |
| `require_document_number_shape()` | `trigger` | plpgsql | volatile | **definer** | {search_path=""} | `row_tenant` |
| `require_floor_price()` | `trigger` | plpgsql | volatile | **definer** | {search_path=""} | `row_tenant` |
| `require_known_capability()` | `trigger` | plpgsql | volatile | invoker | {search_path=""} | — |
| `require_no_active_return()` | `trigger` | plpgsql | volatile | **definer** | {search_path=""} | `row_tenant` |
| `require_open_movement_type()` | `trigger` | plpgsql | volatile | **definer** | {search_path=""} | — |
| `require_return_origin()` | `trigger` | plpgsql | volatile | invoker | {search_path=""} | — |
| `require_returnable_quantity()` | `trigger` | plpgsql | volatile | **definer** | {search_path=""} | `row_tenant` |
| `require_sale_origin()` | `trigger` | plpgsql | volatile | invoker | {search_path=""} | — |
| `require_transformation_shape()` | `trigger` | plpgsql | volatile | **definer** | {search_path=""} | `row_tenant` |
| `reverse_sale_movements()` | `trigger` | plpgsql | volatile | invoker | {search_path=""} | — |
| `search_allows_typo(word text)` | `boolean` | sql | immutable | invoker | — | — |
| `search_fold(value text)` | `text` | sql | immutable | invoker | — | — |
| `search_pivot(q text)` | `text` | sql | immutable | invoker | — | — |
| `search_words(q text)` | `text[]` | sql | immutable | invoker | — | — |
| `seed_tenant_settings(target_tenant uuid)` | `void` | plpgsql | volatile | **definer** | {search_path=""} | `argument_tenant` |
| `set_updated_at()` | `trigger` | plpgsql | volatile | invoker | — | — |
| `tenant_is_its_own_tenant()` | `trigger` | plpgsql | volatile | invoker | — | — |
| `write_return_movements()` | `trigger` | plpgsql | volatile | invoker | {search_path=""} | — |
| `write_sale_movements()` | `trigger` | plpgsql | volatile | invoker | {search_path=""} | — |

---

## Exceptions RLS inscrites — SPEC § 2.1

19 entrées. Une exception n'est pas un précédent : chacune porte son
garde et sa justification en texte, que la base refuse vide.

- `merx.current_app_user` — garde `auth_identity`
  Rend la fiche app_user de l'appelant, déduite du jeton. Bornée à auth.uid() : une seule ligne, la sienne. C'est elle qui donne son défaut à created_by sur toute table conventionnée — le jeton ne porte pas l'identifiant app_user, donc l'écran ne peut pas le remplir (E3-03). E1-02.
- `merx.custom_access_token` — garde `auth_identity`
  Hook Supabase Auth : refuse le jeton d'un compte désactivé, estampille last_seen_at, puis dépose tenant_id et role dans app_metadata. Elle s'exécute hors session, sous supabase_auth_admin, **avant** qu'un commerce existe dans le jeton : un filtre sur le commerce du jeton y serait circulaire. Bornée à l'identifiant de l'événement d'authentification. SPEC § 2.1 ; E0-03, E1-01, E1-02.
- `merx.log_audit` — garde `current_tenant`
  Le seul chemin d'écriture du journal : commerce et auteur viennent du jeton signé, jamais des paramètres (RÈGLE M8-1). Non exécutable par authenticated ; definer parce qu'audit_log est en ajout seul et que ses privilèges d'écriture sont retirés à tout le monde. Bornée à merx.current_tenant_id(). E1-04.
- `merx.next_device_prefix` — garde `argument_tenant`
  Lit les lettres déjà prises d'un commerce pour en donner la suivante, jamais recyclée (E1-03). Bornée à target_tenant, que ses deux appelantes inscrites — public.create_tenant() et public.register_device() — remplissent, et qui portent le droit. E1-03.
- `merx.open_default_warehouse` — garde `row_tenant`
  Ouvre l'unique dépôt d'un commerce à sa naissance (SPEC § 2.4) : la table warehouse n'est jamais exposée, et personne ne doit pouvoir en écrire une ligne. Trigger sur tenant, donc borné à new.id — la ligne écrite **est** le commerce. E3-02.
- `merx.require_consistent_totals` — garde `row_tenant`
  Somme les line_total du document à la confirmation : aucun check ne traverse les lignes. Borné à new.tenant_id et à new.id, donc au document écrit. E4-04.
- `merx.require_document_number_shape` — garde `row_tenant`
  Lit device pour comparer la lettre du numéro à celle de l'appareil de la ligne. Definer parce qu'un employé ne lit pas device (policy restrictive manage_devices, E1-03) : en invoker le garde ne verrait rien et cesserait de garder en silence. Borné à new.tenant_id, le commerce de la ligne écrite, que le with check de tenant_isolation a déjà forcé à celui du jeton. E4-02.
- `merx.require_floor_price` — garde `row_tenant`
  Lit variant.floor_price et sale_document.doc_type — en un seul select, sur le chemin des dix lignes au comptoir — pour opposer le plancher à qui n'a pas override_price_below_floor, et pour sortir tôt sur un retour (E4-06). Borné à new.tenant_id, le commerce de la ligne écrite. E4-04.
- `merx.require_no_active_return` — garde `row_tenant`
  Cherche un retour non annulé issu du bon qu'on annule : sans lui l'inversion des mouvements sale recréditerait un stock que le retour avait déjà rendu. Borné à new.tenant_id, le commerce du bon annulé. E4-06.
- `merx.require_returnable_quantity` — garde `row_tenant`
  Lit les lignes du bon d'origine et celles des retours déjà faits, pour qu'un retour ne rende ni plus de quantité ni plus d'avoir que le bon n'en portait (RÈGLE M3-9) ; lit variant et product pour nommer la variante dans la phrase du refus, et verrouille le bon d'origine pour que deux retours ne se croisent pas. Borné à new.tenant_id, le commerce du retour écrit. E4-06.
- `merx.require_transformation_shape` — garde `row_tenant`
  Lit le type et le statut du document d'origine pour tenir la chaîne admise. Borné à new.tenant_id : un original hors du commerce n'est pas trouvé, le garde laisse passer, et ce sont la clé composite et la RLS qui refusent — un garde qui refuserait là tiendrait lieu d'isolation dans le balayage (E3-01). E4-05.
- `merx.seed_tenant_settings` — garde `argument_tenant`
  Pose les réglages par défaut d'un commerce neuf, en base et nulle part ailleurs (E1-05). Bornée à target_tenant, que public.create_tenant() — inscrite en super_admin — remplit. Hors de portée de l'application : l'écran ne crée aucun réglage. E1-05.
- `public.create_tenant` — garde `super_admin`
  Crée un commerce et sa population initiale — tenant, app_user, device, warehouse. Ne peut pas filtrer sur le commerce du jeton : elle le crée, et l'éditeur qui l'appelle n'en a aucun. Réservée à super_admin, garde en première ligne. E1-01.
- `public.create_worker` — garde `current_tenant`
  Écrit app_user hors RLS : le compte d'authentification est créé par la fonction Edge, qui rappelle la base avec le jeton de l'appelant (même raison qu'E1-01, dit sa migration). Le commerce vient du jeton, le rôle est écrit dans le corps, manage_users est exigé en première ligne. E1-02.
- `public.list_sale_documents` — garde `current_tenant`
  Rend le nom de l'auteur et le libellé de l'appareil de chaque document, que les policies restrictives d'app_user et de device réservent à manage_users et manage_devices — or l'acteur de la story est celui qui tient le comptoir. Et la policy OR merx.is_super_admin() de sale_document met toute liste en Seq Scan sur les documents de tous les commerces (BACKLOG E0-03). N'expose qu'un full_name et un libellé par document du commerce du jeton, jamais le registre des employés ni celui des appareils. Deux gardes : can(create_sale) en première ligne, et le filtre sur merx.current_tenant_id() — seul garde d'isolation de ce chemin. E4-07.
- `public.list_stock_movements` — garde `current_tenant`
  Rend le nom de l'auteur de chaque mouvement, que la policy restrictive d'app_user réserve à manage_users — or l'acteur de la story est le vendeur, et le critère exige l'auteur. N'expose qu'un full_name par mouvement d'une variante du commerce du jeton, jamais le registre des employés. Trois gardes : can(view_catalogue) en première ligne, l'appartenance de la variante au commerce (zéro ligne sinon), et le filtre sur merx.current_tenant_id() des mouvements rendus. E3-02.
- `public.register_device` — garde `current_tenant`
  Un worker enregistre sa tablette, alors que la policy restrictive manage_devices lui ferme device en lecture comme en écriture. Le commerce vient du jeton ; un identifiant connu ailleurs répond « introuvable ». E1-03.
- `public.search_products` — garde `current_tenant`
  Sous RLS, Postgres n'utilise comme condition d'index que des prédicats leakproof ; like, lower, unaccent et pg_trgm ne le sont pas, et postgres n'est pas superutilisateur. Mesuré en E2-04 (cinq commerces de 10 000 produits, mêmes 1 251 lignes rendues) : Seq Scan de 417 à 472 ms sous authenticated, 8,6 à 9,7 ms par l'index trigramme. Le filtre merx.current_tenant_id() en tête du corps est le seul garde d'isolation. SPEC § 2.1, exception nommée.
- `public.set_user_active` — garde `current_tenant`
  Met à jour app_user hors RLS, sur une ligne du commerce du jeton seulement ; manage_users est exigé en première ligne. E1-02.

---

## Matrice `merx.role_capability` — SPEC § 3.1

La seule copie qui gouverne quelque chose : `merx.can()` ne lit qu'elle. Les
trois autres copies — l'union `Capability` et l'objet `CAPABILITIES` de
`src/lib/auth/permissions.ts`, et les deux fichiers de test qui les confrontent —
en sont le reflet, et la suite rougit dès qu'une capacité manque à l'une d'elles
(CLAUDE.md).

`super_admin` n'y figure pas : l'éditeur est traité en amont, par
`merx.is_super_admin()` et par la policy `super_admin_all`.

| capacité | owner | worker |
| --- | --- | --- |
| `adjust_stock` | ✓ | — |
| `approve_stock_variance` | ✓ | — |
| `cancel_document` | ✓ | — |
| `collect_payment` | ✓ | ✓ |
| `count_stock` | ✓ | ✓ |
| `create_sale` | ✓ | ✓ |
| `exceed_credit_limit` | ✓ | — |
| `manage_client` | ✓ | ✓ |
| `manage_devices` | ✓ | — |
| `manage_price_list` | ✓ | — |
| `manage_product` | ✓ | — |
| `manage_settings` | ✓ | — |
| `manage_users` | ✓ | — |
| `override_price` | ✓ | ✓ |
| `override_price_below_floor` | ✓ | — |
| `receive_goods` | ✓ | ✓ |
| `set_credit_limit` | ✓ | — |
| `view_audit_log` | ✓ | — |
| `view_catalogue` | ✓ | ✓ |
| `view_cost` | ✓ | — |
| `view_reports` | ✓ | — |

---

## Registres de décision de `merx`

Les registres qui ne parlent d'aucune table en particulier : une chaîne admise,
un écrivain déclaré, un type ouvert sur une capacité. Ce sont des **données**, et
c'est volontaire — une règle écrite en données se lit, se teste et s'énumère,
alors qu'une règle écrite dans un corps de fonction se contourne en écrivant
autrement (BACKLOG E4-05).

Les registres clés par table, eux, se lisent dans le bloc de leur table.

### `merx.document_transformation`

| source_type | target_type |
| --- | --- |
| `quote` | `order` |
| `quote` | `delivery_note` |
| `order` | `delivery_note` |
| `delivery_note` | `return` |

### `merx.movement_type_capability`

| movement_type | capability |
| --- | --- |
| `sale` | `create_sale` |
| `return` | `create_sale` |
| `adjustment` | `adjust_stock` |
| `sale_cancellation` | `cancel_document` |

### `merx.movement_writer`

| function_name | movement_type |
| --- | --- |
| `reverse_sale_movements` | `sale_cancellation` |
| `write_return_movements` | `return` |
| `write_sale_movements` | `sale` |

### `merx.setting_default`

| key | value |
| --- | --- |
| `print_header` | `{"phone":"","address":"","business_name":""}` |
| `default_language` | `fr` |
| `printer_address` | `(vide)` |
