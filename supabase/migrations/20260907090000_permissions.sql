-- ============================================================================
-- Merx — rôles, capacités, et confidentialité des coûts
--
-- Référence : docs/SPEC.md § 3 (rôles, RÈGLE de filtrage serveur, RÈGLE de
--             placement des coûts), § 3.1 (matrice), § 2.1 (RLS),
--             docs/BACKLOG.md E0-05.
--
-- L'enum `user_role` existe depuis E0-03 : la policy `super_admin_all` devait
-- tester un rôle. Cette migration apporte la substance — la matrice § 3.1 en
-- données, le helper unique qui la consulte, et le mécanisme qui rend une
-- colonne de coût *absente* de la réponse d'un `worker`.
--
-- Sur ce dernier point, une chose est à comprendre avant de lire le reste.
-- PostgREST parle à Postgres sous un seul rôle SQL, `authenticated` : le patron
-- et l'employé sont le même rôle, ils ne diffèrent que par un claim du jeton.
-- Donc :
--
--   — les GRANT par colonne ne peuvent pas les distinguer, et un privilège
--     manquant fait échouer `select=*` en 42501 pour tout le monde plutôt que
--     de faire disparaître la colonne ;
--   — la RLS est par *ligne*. Il n'existe pas de RLS par colonne ;
--   — une vue `case when merx.can('view_cost') then cost_price end` renvoie
--     `"cost_price": null`. La clé est dans la réponse. C'est du masquage,
--     exactement ce que la RÈGLE § 3 refuse.
--
-- Il n'y a donc qu'une façon d'obtenir l'absence réelle de la clé : la colonne
-- confidentielle ne vit sur aucune relation qu'un `worker` peut lire. C'est la
-- RÈGLE de placement des coûts, § 3. Ce fichier livre le mécanisme ; les
-- relations concernées arrivent avec le catalogue (E2).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- La matrice § 3.1, en données
--
-- Une ligne par case cochée. Écrire la matrice en données plutôt qu'en `if`
-- disséminés a une conséquence qui compte : elle est interrogeable, donc
-- comparable à la copie que le front en tient (`src/lib/auth/permissions.ts`).
-- Une dérive entre les deux casse le build au lieu de s'installer.
--
-- `super_admin` n'y figure pas, et ce n'est pas un oubli : la matrice § 3.1 n'a
-- que deux colonnes. L'éditeur est traité en amont par `merx.can()`, comme il
-- l'est déjà par la policy `super_admin_all` — un privilège qui se lit à un
-- seul endroit.
--
-- La table vit dans `merx` : ce n'est pas du métier, et l'API ne l'expose pas.
-- ----------------------------------------------------------------------------

create table merx.role_capability (
  capability text             not null,
  role       public.user_role not null,
  primary key (capability, role)
);

comment on table merx.role_capability is
  'Matrice des droits, SPEC § 3.1. Une ligne par case cochée. super_admin '
  'n''y figure pas : merx.can() le traite en amont.';

insert into merx.role_capability (capability, role) values
  -- Voir le catalogue et le stock
  ('view_catalogue',            'owner'),
  ('view_catalogue',            'worker'),
  -- Créer / modifier un produit
  ('manage_product',            'owner'),
  -- Voir prix d'achat et marge
  ('view_cost',                 'owner'),
  -- Modifier la grille de prix
  ('manage_price_list',         'owner'),
  -- Créer un bon de vente
  ('create_sale',               'owner'),
  ('create_sale',               'worker'),
  -- Forcer un prix à la ligne
  ('override_price',            'owner'),
  ('override_price',            'worker'),
  -- L'astérisque de § 3.1 : le `worker` force au-dessus du plancher seulement.
  -- La capacité existe dès aujourd'hui pour que la règle de rôle soit tout
  -- entière ici ; la comparaison au `floor_price` appartient à M3 et suppose la
  -- grille de prix (E2, E4). E4 appellera cette capacité, il n'aura pas à
  -- inventer un droit.
  ('override_price_below_floor', 'owner'),
  -- Annuler un document confirmé
  ('cancel_document',           'owner'),
  -- Créer / modifier un client
  ('manage_client',             'owner'),
  ('manage_client',             'worker'),
  -- Fixer le plafond de crédit
  ('set_credit_limit',          'owner'),
  -- Dépasser le plafond
  ('exceed_credit_limit',       'owner'),
  -- Encaisser
  ('collect_payment',           'owner'),
  ('collect_payment',           'worker'),
  -- Saisir une réception
  ('receive_goods',             'owner'),
  ('receive_goods',             'worker'),
  -- Compter un inventaire
  ('count_stock',               'owner'),
  ('count_stock',               'worker'),
  -- Valider les écarts
  ('approve_stock_variance',    'owner'),
  -- Voir les rapports
  ('view_reports',              'owner'),
  -- Gérer les utilisateurs
  ('manage_users',              'owner');


-- ----------------------------------------------------------------------------
-- Le rôle métier de l'appelant
--
-- Même précaution qu'en E0-03 : le `role` de premier niveau du JWT est le rôle
-- Postgres (`authenticated`), le rôle métier est celui d'`app_metadata`. Les
-- confondre donnerait le super-admin à toute session authentifiée.
--
-- Un rôle inconnu ou absent rend NULL plutôt que de lever : un jeton forgé, ou
-- émis avant la pose du hook, doit se traduire par une absence de droit — pas
-- par une exception qu'un appelant pourrait oublier d'attraper. Le filtre `in`
-- avant le cast n'est donc pas décoratif : `'patron'::user_role` lèverait.
-- ----------------------------------------------------------------------------

create function merx.current_user_role()
returns public.user_role
language sql
stable
security invoker
set search_path = ''
as $function$
  select case
    when auth.jwt() -> 'app_metadata' ->> 'role'
         in ('super_admin', 'owner', 'worker')
    then (auth.jwt() -> 'app_metadata' ->> 'role')::public.user_role
  end
$function$;

comment on function merx.current_user_role() is
  'Rôle métier de l''appelant, lu dans le JWT signé. NULL si absent ou '
  'inconnu. SPEC § 3.';


-- ----------------------------------------------------------------------------
-- Le helper unique
--
-- E0-05 : « un helper serveur unique porte toutes les vérifications de droits ».
-- Tout contrôle de droit du projet passe par ici — policies comprises. Un droit
-- vérifié ailleurs est un droit que la matrice ne gouverne pas.
--
-- `security definer` : la matrice vit dans `merx`, sur laquelle `authenticated`
-- n'a aucun droit de lecture et ne doit pas en recevoir. La fonction ne rend
-- qu'un booléen ; elle n'expose pas la table.
--
-- Le paramètre s'appelle `wanted` et non `capability` : sous ce dernier nom il
-- masquerait la colonne du même nom dans le `exists`, et la condition serait
-- vraie pour n'importe quelle capacité. Un droit universel accordé par une
-- collision de noms se relit comme du code juste.
-- ----------------------------------------------------------------------------

create function merx.can(wanted text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when merx.is_super_admin() then true
    else exists (
      select 1
      from merx.role_capability rc
      where rc.capability = wanted
        and rc.role = merx.current_user_role()
    )
  end
$function$;

comment on function merx.can(text) is
  'Le seul point de vérification des droits. Consulte la matrice SPEC § 3.1. '
  'super_admin passe partout. E0-05.';

revoke execute on function merx.can(text) from public;
grant execute on function merx.can(text) to authenticated;


-- ----------------------------------------------------------------------------
-- Relations confidentielles
--
-- Le registre dit quelles tables portent une restriction, et laquelle. Il sert
-- deux fois : à la policy, et aux tests — `conventions.test.ts` s'en sert pour
-- refuser une colonne de coût posée sur une table ordinaire, et
-- `permissions.test.ts` pour balayer toutes les relations confidentielles sans
-- qu'aucune ne soit nommée à la main. Une relation ajoutée en E2 entre d'elle-
-- même dans les deux.
-- ----------------------------------------------------------------------------

create table merx.confidential_registry (
  table_name text primary key,
  capability text not null
);

comment on table merx.confidential_registry is
  'Tables dont la lecture exige une capacité, et laquelle. SPEC § 3.';


-- ----------------------------------------------------------------------------
-- La restriction, appliquée par une fonction
--
-- Une policy **restrictive**, et c'est tout l'intérêt : les policies
-- restrictives se combinent en ET avec les permissives d'isolation. Celle-ci ne
-- peut donc qu'ajouter une condition, jamais élargir ce que `tenant_isolation`
-- laisse passer. Une policy permissive de plus, elle, aurait été un OU — une
-- porte ouverte à côté de la serrure.
--
-- `with check` autant que `using` : sans lui, un `worker` ne lirait pas les
-- coûts mais pourrait en écrire.
--
-- La capacité est vérifiée contre la matrice avant la pose : une policy qui
-- interroge une capacité inexistante est toujours fausse, donc verrouille la
-- table en silence. Mieux vaut refuser la migration.
-- ----------------------------------------------------------------------------

-- Le paramètre ne s'appelle pas `capability` : sous ce nom il entrerait en
-- collision avec la colonne du même nom dans le `exists` ci-dessous, et plpgsql
-- refuserait la requête comme ambiguë — à l'exécution de la migration, pas à sa
-- lecture.
create function merx.apply_capability_restriction(target regclass, required_capability text)
returns void
language plpgsql
as $function$
declare
  table_name text;
begin
  if not exists (
    select 1 from merx.role_capability rc where rc.capability = required_capability
  ) then
    raise exception
      'Capacité inconnue : %. Elle doit figurer dans merx.role_capability (SPEC § 3.1).',
      required_capability;
  end if;

  execute format($ddl$
    create policy capability_restriction on %s
      as restrictive for all to authenticated
      using (merx.can(%L))
      with check (merx.can(%L))
  $ddl$, target, required_capability, required_capability);

  select c.relname into table_name from pg_class c where c.oid = target;

  insert into merx.confidential_registry (table_name, capability)
  values (table_name, required_capability);
end;
$function$;

comment on function merx.apply_capability_restriction(regclass, text) is
  'Pose une policy restrictive exigeant une capacité, et inscrit la table au '
  'registre confidentiel. SPEC § 3, E0-05.';
