/*
 * E0-04 — la session : restaurée, refusée, ouverte, fermée.
 *
 * Les critères d'acceptation « session persistante entre les redémarrages » et
 * « déconnexion vidant la session locale » se vérifient ici, au niveau où ils
 * se décident. Ce que ce fichier ne peut pas prouver — qu'un jeton réel porte
 * un commerce — est vérifié par `supabase/tests/auth.test.ts`.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { AuthProvider } from '@/lib/auth/AuthProvider'
import { useAuth } from '@/lib/auth/context'
import { AUTH_MESSAGES } from '@/lib/auth/messages'
import { createFakeAuthClient, fakeSession, type FakeAuthClient } from '@/test/fakeAuth'

/** Sonde : elle affiche l'état, et déclenche les deux actions. */
function Probe() {
  const { status, user, message, signIn, signOut } = useAuth()

  return (
    <div>
      <p data-testid="status">{status}</p>
      <p data-testid="tenant">{user?.tenantId ?? '—'}</p>
      <p data-testid="email">{user?.email ?? '—'}</p>
      <p data-testid="role">{user?.role ?? '—'}</p>
      <p data-testid="message">{message ?? '—'}</p>
      <button type="button" onClick={() => void signIn('patron@merx.test', 'motdepasse')}>
        connexion
      </button>
      <button type="button" onClick={() => void signIn('', '')}>
        connexion vide
      </button>
      <button type="button" onClick={() => void signOut()}>
        déconnexion
      </button>
    </div>
  )
}

function renderWith(client: FakeAuthClient) {
  render(
    <AuthProvider client={client}>
      <Probe />
    </AuthProvider>,
  )
}

const status = (): string => screen.getByTestId('status').textContent ?? ''
const message = (): string => screen.getByTestId('message').textContent ?? ''

describe('au démarrage', () => {
  it('restaure la session du stockage local — la session survit au redémarrage', async () => {
    renderWith(createFakeAuthClient({ initialSession: fakeSession() }))

    await waitFor(() => expect(status()).toBe('signed-in'))
    expect(screen.getByTestId('tenant')).toHaveTextContent('tenant-a')
    expect(screen.getByTestId('email')).toHaveTextContent('patron@merx.test')
    expect(screen.getByTestId('role')).toHaveTextContent('owner')
  })

  it('sans session, se déclare déconnecté', async () => {
    renderWith(createFakeAuthClient())

    await waitFor(() => expect(status()).toBe('signed-out'))
    expect(message()).toBe('—')
  })

  /*
   * `loading` n'est pas une coquetterie : sans cet état, le premier rendu d'un
   * utilisateur connecté vaut `signed-out`, et le garde de route le renvoie au
   * formulaire à chaque démarrage de l'application.
   */
  it("commence par 'loading', avant que le stockage local soit relu", () => {
    renderWith(createFakeAuthClient({ initialSession: fakeSession() }))

    expect(status()).toBe('loading')
  })
})

describe('un compte sans commerce', () => {
  it('est déconnecté, et on lui dit pourquoi', async () => {
    const client = createFakeAuthClient({ initialSession: fakeSession({ tenantId: null }) })
    renderWith(client)

    await waitFor(() => expect(status()).toBe('signed-out'))

    // Le message nomme la cause : le commerçant sait quoi demander, et son
    // responsable sait quoi corriger. Copie exacte, elle fait partie du contrat.
    await waitFor(() =>
      expect(message()).toBe(
        "Votre compte n'est rattaché à aucun commerce. Contactez votre responsable.",
      ),
    )
    expect(message()).toBe(AUTH_MESSAGES.noTenant)
    expect(client.calls.signOut).toHaveBeenCalled()
  })

  it("n'expose aucun utilisateur, même si la session existe", async () => {
    renderWith(createFakeAuthClient({ initialSession: fakeSession({ tenantId: null }) }))

    await waitFor(() => expect(status()).toBe('signed-out'))
    expect(screen.getByTestId('tenant')).toHaveTextContent('—')
  })

  /*
   * Le cas qui arrive en cours de journée : le patron désactive la fiche, le
   * jeton se renouvelle et revient sans commerce (E0-03). L'utilisateur doit
   * sortir de l'application, pas y rester devant des écrans vides.
   */
  it('sort de la session quand la fiche est désactivée en cours de route', async () => {
    const client = createFakeAuthClient({ initialSession: fakeSession() })
    renderWith(client)
    await waitFor(() => expect(status()).toBe('signed-in'))

    client.emit(fakeSession({ tenantId: null }))

    /*
     * Les deux attentes sont dans le même `waitFor`, et ce n'est pas du confort.
     * Le fournisseur déconnecte d'abord, explique ensuite — `await signOut()`
     * puis `setMessage()` — de sorte que le message ne puisse jamais s'afficher
     * sur un écran encore protégé. Le statut bascule donc un tour de boucle
     * avant le message : les séparer rendait ce test défaillant une fois sur
     * six, sur un ordre d'événements pourtant voulu.
     */
    await waitFor(() => {
      expect(status()).toBe('signed-out')
      expect(message()).toBe(AUTH_MESSAGES.noTenant)
    })
  })
})

describe('la connexion', () => {
  it('ouvre la session quand les identifiants passent', async () => {
    const client = createFakeAuthClient()
    renderWith(client)
    await waitFor(() => expect(status()).toBe('signed-out'))

    await userEvent.click(screen.getByRole('button', { name: 'connexion' }))

    await waitFor(() => expect(status()).toBe('signed-in'))
    expect(client.calls.signInWithPassword).toHaveBeenCalledWith({
      email: 'patron@merx.test',
      password: 'motdepasse',
    })
  })

  it.each([
    ['identifiants refusés', { message: 'Invalid login credentials', status: 400 }, AUTH_MESSAGES.badCredentials],
    ['serveur injoignable', { message: 'Failed to fetch' }, AUTH_MESSAGES.offline],
    ['serveur en erreur', { message: 'Internal', status: 500 }, AUTH_MESSAGES.offline],
    ['trop de tentatives', { message: 'Rate limit', status: 429 }, AUTH_MESSAGES.tooManyRequests],
    /*
     * E1-02 : le hook d'émission refuse le jeton d'un compte désactivé et
     * Supabase Auth relaie son refus en 403. Sans ce cas, l'employé coupé par
     * son patron lirait « mot de passe incorrect » et retaperait son mot de
     * passe jusqu'à appeler pour signaler une panne.
     */
    ['compte désactivé', { message: 'Ce compte a été désactivé.', status: 403 }, AUTH_MESSAGES.deactivated],
  ])('explique le refus — %s', async (_label, error, expected) => {
    renderWith(createFakeAuthClient({ signInResult: { error } }))
    await waitFor(() => expect(status()).toBe('signed-out'))

    await userEvent.click(screen.getByRole('button', { name: 'connexion' }))

    await waitFor(() => expect(message()).toBe(expected))
    expect(status()).toBe('signed-out')
  })

  it("ne part pas sur le réseau quand un champ est vide", async () => {
    const client = createFakeAuthClient()
    renderWith(client)
    await waitFor(() => expect(status()).toBe('signed-out'))

    await userEvent.click(screen.getByRole('button', { name: 'connexion vide' }))

    await waitFor(() => expect(message()).toBe(AUTH_MESSAGES.missingFields))
    expect(client.calls.signInWithPassword).not.toHaveBeenCalled()
  })

  it('efface le refus précédent à la tentative suivante', async () => {
    const client = createFakeAuthClient()
    renderWith(client)
    await waitFor(() => expect(status()).toBe('signed-out'))

    await userEvent.click(screen.getByRole('button', { name: 'connexion vide' }))
    await waitFor(() => expect(message()).toBe(AUTH_MESSAGES.missingFields))

    await userEvent.click(screen.getByRole('button', { name: 'connexion' }))

    await waitFor(() => expect(status()).toBe('signed-in'))
    expect(message()).toBe('—')
  })
})

describe('la déconnexion', () => {
  it('vide la session', async () => {
    const client = createFakeAuthClient({ initialSession: fakeSession() })
    renderWith(client)
    await waitFor(() => expect(status()).toBe('signed-in'))

    await userEvent.click(screen.getByRole('button', { name: 'déconnexion' }))

    await waitFor(() => expect(status()).toBe('signed-out'))
    expect(client.calls.signOut).toHaveBeenCalled()
    expect(screen.getByTestId('tenant')).toHaveTextContent('—')
  })

  /*
   * Hors réseau, la révocation côté serveur échoue. La tablette du comptoir
   * doit être déconnectée quand même — sinon le seul moyen de fermer une
   * session est d'attendre le retour du réseau, devant le client.
   */
  it('déconnecte quand même si le serveur ne répond pas', async () => {
    const client = createFakeAuthClient({
      initialSession: fakeSession(),
      signOutError: { message: 'Failed to fetch' },
    })
    renderWith(client)
    await waitFor(() => expect(status()).toBe('signed-in'))

    await userEvent.click(screen.getByRole('button', { name: 'déconnexion' }))

    await waitFor(() => expect(status()).toBe('signed-out'))
    expect(client.calls.signOut).toHaveBeenCalledWith({ scope: 'local' })
  })
})
