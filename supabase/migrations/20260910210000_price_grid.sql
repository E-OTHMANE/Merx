-- ============================================================================
-- Merx — la grille de prix par palier, et le prix d'achat
--
-- Référence : docs/SPEC.md § 2.3 (RÈGLES product/variant), § 2.5 (hors-ligne),
--             § 2.6 (RÈGLE de la charge de saisie), § 3 (RÈGLE de placement
--             des coûts), § 3.1 (`view_cost`, `manage_price_list`), § 6 M1
--             (RÈGLE M1-2), docs/BACKLOG.md E2-03.
--
-- Trois choses, et rien de plus :
--
--   1. `variant_cost`, la relation qui porte le prix d'achat — décidée en
--      E0-05, restreinte par le mécanisme livré ce jour-là ;
--   2. `price_break.unit_price` accepte l'absence : un produit naît sans prix ;
--   3. la ligne `min_qty = 1` de chaque variante, créée d'office par la base
--      et gardée contre sa disparition (RÈGLE M1-2).
--
-- La résolution du prix n'est pas ici. Elle tourne sur l'appareil, parce que
-- la vente doit la faire hors-ligne (E4-04, SPEC § 2.5) :
-- `src/modules/catalogue/pricing.ts`.
--
-- Rien de E2-04 à E2-06, rien de E4 : ni incitation au palier, ni forçage, ni
-- comparaison au plancher.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. `variant_cost` — le prix d'achat, hors de toute relation lisible par tous
--
-- SPEC § 3, RÈGLE de placement des coûts. PostgREST parle à Postgres sous un
-- seul rôle : le patron et l'employé ne diffèrent que par un claim. Aucune
-- permission par colonne ne les sépare, et une colonne masquée par une vue
-- rendrait `"cost_price": null` — la clé dans la réponse. La seule absence
-- réelle est structurelle : la colonne vit sur une relation que l'employé ne
-- peut pas lire du tout. `variant` ne porte donc aucun coût, et n'en portera
-- jamais — `supabase/tests/conventions.ts` refuse la colonne sur toute table
-- qui n'est pas restreinte par `view_cost`.
--
-- Une ligne par variante au plus, et la ligne est facultative : pas de coût
-- connu, pas de ligne. Effacer le coût supprime la ligne, d'où l'absence de
-- `deleted_at` — une suppression douce laisserait une ligne « sans coût » qui
-- se distinguerait mal de l'absence, et l'unicité devrait l'ignorer. E8-03 la
-- créera à la première réception, « si absente ».
--
-- `cost_price` est obligatoire *dans la ligne* : une ligne sans coût n'a pas
-- de raison d'exister. La table ne reçoit pas de formulaire de création au sens
-- de SPEC § 2.6 — elle n'est pas au registre des formulaires.
-- ----------------------------------------------------------------------------

create table public.variant_cost (
  id         uuid primary key default gen_random_uuid(),
  variant_id uuid not null,
  cost_price public.money_amount not null check (cost_price >= 0)
);

select merx.apply_business_conventions('public.variant_cost');

comment on table public.variant_cost is
  'Prix d''achat d''une variante, une ligne au plus. Relation restreinte par '
  'view_cost : un worker n''en lit aucune ligne, et la clé cost_price '
  'n''apparaît dans aucune réponse qui lui est faite. SPEC § 3, § 6. '
  'Pas de restriction d''écriture (apply_write_capability_restriction) en '
  'plus de view_cost, et ce n''est pas un oubli : elle refuserait l''employé '
  'avec le même 42501 que la policy view_cost, dont le with check couvre déjà '
  'l''écriture ; aucun test ne pourrait la faire tomber seule, elle '
  'n''existerait que pour la forme (CLAUDE.md, E1-02). Ne pas l''ajouter sans '
  'une capacité distincte et un test qui la distingue.';

comment on column public.variant_cost.cost_price is
  'Prix d''achat unitaire. Mis à jour en coût moyen pondéré par la réception '
  '(E8-03). Jamais sur variant — SPEC § 3, RÈGLE de placement des coûts.';

alter table public.variant_cost
  add constraint variant_cost_one_per_variant unique (variant_id);

-- SPEC § 4 : composite sur le commerce. La cascade suit celle de la variante :
-- une variante purgée n'a plus de coût à garder.
alter table public.variant_cost
  add constraint variant_cost_variant_id_fkey
  foreign key (tenant_id, variant_id) references public.variant (tenant_id, id)
  on delete cascade;

/*
 * La restriction : une policy restrictive `for all`, exigeant `view_cost`, en
 * lecture comme en écriture. C'est le mécanisme de E0-05, appelé tel quel ; il
 * inscrit aussi la table au registre confidentiel, que lisent les balayages de
 * `conventions.test.ts`, `isolation.test.ts` et `permissions.test.ts`.
 *
 * **Un seul garde, et c'est délibéré.** On pourrait croire qu'il manque la
 * restriction d'écriture — `merx.apply_write_capability_restriction()`, avec
 * `manage_price_list` ou `manage_product` — puisque « saisir le prix d'achat »
 * n'est pas « voir le prix d'achat ». Elle ne manque pas. Posée ici, elle
 * refuserait l'employé avec le même `42501` que la policy `view_cost`, dont le
 * `with check` couvre déjà l'écriture. Aucun test ne pourrait la faire tomber
 * seule : retirée, rien ne changerait de ce qu'une assertion peut voir. Un
 * garde qu'aucun test ne distingue n'existe que pour la forme (CLAUDE.md,
 * règle posée en E1-02). La matrice § 3.1 n'a d'ailleurs qu'une case pour le
 * prix d'achat, et elle revient au patron seul.
 *
 * Le jour où un rôle verrait le coût sans pouvoir l'écrire, la question se
 * posera avec une capacité nouvelle et un test qui la distingue — pas avant.
 */
select merx.apply_capability_restriction('public.variant_cost', 'view_cost');

comment on policy capability_restriction on public.variant_cost is
  'Lecture et écriture exigent view_cost. Pas de restriction d''écriture en '
  'plus, et ce n''est pas un oubli : elle refuserait l''employé avec le même '
  '42501, aucun test ne pourrait la distinguer de celle-ci, et elle '
  'n''existerait que pour la forme (CLAUDE.md, E1-02). Voir la migration '
  'price_grid.';


-- ----------------------------------------------------------------------------
-- 2. Un produit naît sans prix
--
-- SPEC § 2.6 : le seul champ obligatoire est le nom. Or la ligne `min_qty = 1`
-- est obligatoire et créée par défaut (RÈGLE M1-2) — elle naît donc avec la
-- variante, avant que personne n'ait saisi de prix. Son prix est absent : « prix
-- non renseigné ». La vente ne propose alors aucun prix automatique, et le
-- vendeur le saisit (E4) — rien ne bloque une vente.
--
-- Un prix à 0 par défaut aurait été le pire choix : un oubli ferait vendre
-- gratuitement, sans que rien ne le signale. Arbitré en E2-03.
--
-- L'absence est acceptée sur tout palier, pas seulement sur la ligne de base.
-- L'écran n'enregistre jamais de palier sans prix ; la base n'a pas de raison
-- d'en décider autrement, et une résolution qui tombe sur un palier sans prix
-- rend « pas de prix automatique », comme pour la ligne de base.
-- ----------------------------------------------------------------------------

alter table public.price_break alter column unit_price drop not null;

comment on column public.price_break.unit_price is
  'Prix unitaire à partir de min_qty. NULL : prix non renseigné, aucun prix '
  'automatique — jamais 0 par défaut, qui ferait vendre gratuitement. E2-03.';


-- ----------------------------------------------------------------------------
-- 3. RÈGLE M1-2 — la ligne `min_qty = 1`, créée par la base
--
-- « Une ligne `min_qty = 1` est obligatoire. » Pour toute variante, pas
-- seulement la variante par défaut : chaque variante se prix et se vend.
--
-- Créée par la base et non par l'écran, pour la même raison que la variante
-- par défaut (E2-01) : une variante qui arrive par l'import (E2-05) ou par la
-- synchronisation (E9) passe par ici aussi.
--
-- **Elle porte l'identifiant de sa variante** (`price_break.id = variant.id`).
-- Même raisonnement qu'en E2-01 : la tablette hors-ligne qui crée un produit
-- crée sa variante et la ligne de base en local ; si le serveur tirait un
-- identifiant au hasard, il existerait deux lignes `min_qty = 1` au retour du
-- réseau, et l'unicité des paliers bloquerait la file de synchronisation. Avec
-- la règle, les deux fabriquent la même ligne sans se parler. Pour la variante
-- par défaut, la chaîne est complète : produit, variante et ligne de base
-- partagent un seul identifiant, chacun dans sa table.
--
-- `security invoker` : l'insertion passe par la policy d'écriture de
-- `price_break` (`manage_price_list`), sous l'identité de celui qui crée la
-- variante. Le patron a les deux capacités ; l'employé est refusé plus tôt,
-- par la policy de `variant`.
-- ----------------------------------------------------------------------------

create function merx.create_base_price_break()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  insert into public.price_break (id, tenant_id, variant_id, min_qty, created_by, device_id)
  values (new.id, new.tenant_id, new.id, 1, new.created_by, new.device_id);
  return null;
end;
$function$;

comment on function merx.create_base_price_break() is
  'Trigger AFTER INSERT sur variant : crée la ligne min_qty = 1, sans prix, '
  'sous l''identifiant de la variante. RÈGLE M1-2, E2-03.';

create trigger create_base_price_break
  after insert on public.variant
  for each row execute function merx.create_base_price_break();

-- Les variantes qui existent déjà. Aucune n'existe hors du stack local, mais la
-- RÈGLE vaut pour toutes, pas pour celles nées après cette migration.
insert into public.price_break (id, tenant_id, variant_id, min_qty, created_by, device_id)
select v.id, v.tenant_id, v.id, 1, v.created_by, v.device_id
from public.variant v
where not exists (
  select 1 from public.price_break pb
  where pb.variant_id = v.id and pb.min_qty = 1 and pb.deleted_at is null
);


-- ----------------------------------------------------------------------------
-- La ligne de base ne disparaît pas
--
-- Obligatoire veut dire toujours, pas seulement à la création. Deux chemins
-- pouvaient la faire disparaître, et chacun a son garde, avec son propre
-- message : les deux répondent `23514`, et un test qui ne lirait que le code ne
-- saurait pas lequel a refusé (CLAUDE.md, E1-02).
--
--   G1. La supprimer. Refusé tant que la variante existe. Supprimer la
--       variante reste possible : la cascade retire ses paliers après elle, et
--       le garde voit alors une variante disparue — même motif que
--       `merx.keep_one_variant()`.
--
--   G2. La modifier de sorte qu'elle ne soit plus la ligne de base vivante de
--       sa variante : `min_qty` changé, suppression douce, `variant_id`
--       changé. Son prix, lui, se modifie librement — c'est à cela qu'elle sert.
--
-- Une seconde ligne `min_qty = 1` vivante est refusée par l'unicité des paliers
-- (`price_break_min_qty_per_variant`, E2-01) : pas de garde de plus pour cela.
--
-- `security invoker` : l'appelant ne voit que son commerce, et la clé
-- composite garantit que la variante y est.
-- ----------------------------------------------------------------------------

create function merx.keep_base_price_break()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if old.min_qty = 1
     and old.deleted_at is null
     and exists (select 1 from public.variant v where v.id = old.variant_id)
  then
    raise exception 'Le prix à l''unité (quantité 1) est obligatoire : cette ligne ne se supprime pas tant que la variante existe.'
      using errcode = '23514';
  end if;
  return old;
end;
$function$;

comment on function merx.keep_base_price_break() is
  'Trigger BEFORE DELETE sur price_break : refuse de supprimer la ligne '
  'min_qty = 1 d''une variante qui existe encore. RÈGLE M1-2, E2-03.';

create trigger keep_base_price_break
  before delete on public.price_break
  for each row execute function merx.keep_base_price_break();


create function merx.pin_base_price_break()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if old.min_qty = 1
     and old.deleted_at is null
     and (new.min_qty <> 1
          or new.deleted_at is not null
          or new.variant_id is distinct from old.variant_id)
  then
    raise exception 'La ligne du prix à l''unité reste à la quantité 1, sur sa variante : seul son prix se modifie.'
      using errcode = '23514';
  end if;
  return new;
end;
$function$;

comment on function merx.pin_base_price_break() is
  'Trigger BEFORE UPDATE sur price_break : la ligne min_qty = 1 reste la ligne '
  'de base vivante de sa variante ; seul son prix change. RÈGLE M1-2, E2-03.';

create trigger pin_base_price_break
  before update on public.price_break
  for each row execute function merx.pin_base_price_break();
