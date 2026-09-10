/*
 * E0-04 — « Les routes protégées redirigent vers la connexion ».
 *
 * Le garde se teste par les routes, pas isolément : ce qui compte n'est pas
 * qu'un composant rende `<Navigate>`, c'est qu'une URL protégée aboutisse au
 * formulaire — et qu'elle n'y aboutisse pas pendant que la session est encore
 * en cours de relecture.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import { AppRoutes } from '@/app/routes'
import { AuthProvider } from '@/lib/auth'
import { createFakeAuthClient, fakeSession, type FakeAuthClient } from '@/test/fakeAuth'

function renderAt(path: string, client: FakeAuthClient) {
  render(
    <AuthProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AuthProvider>,
  )
  return client
}

const loginScreen = () => screen.queryByRole('button', { name: 'Se connecter' })
const homeScreen = () => screen.queryByRole('button', { name: 'Se déconnecter' })

describe('sans session', () => {
  it.each([['/'], ['/un-chemin-inconnu']])('renvoie %s vers la connexion', async (path) => {
    renderAt(path, createFakeAuthClient())

    await waitFor(() => expect(loginScreen()).toBeInTheDocument())
    expect(homeScreen()).not.toBeInTheDocument()
  })

  /*
   * Le piège de tout garde de route : pendant `loading`, la session peut encore
   * exister. Afficher la connexion à ce moment renverrait au formulaire, à
   * chaque démarrage, un utilisateur parfaitement connecté.
   */
  it("n'affiche ni l'un ni l'autre pendant la relecture de la session", () => {
    renderAt('/', createFakeAuthClient({ initialSession: fakeSession() }))

    expect(loginScreen()).not.toBeInTheDocument()
    expect(homeScreen()).not.toBeInTheDocument()
    expect(screen.getByLabelText('Chargement')).toHaveAttribute('aria-busy', 'true')
  })
})

describe('avec une session', () => {
  it('laisse entrer sur la route protégée', async () => {
    renderAt('/', createFakeAuthClient({ initialSession: fakeSession() }))

    await waitFor(() => expect(homeScreen()).toBeInTheDocument())
    expect(loginScreen()).not.toBeInTheDocument()
  })

  it("détourne le formulaire de connexion vers l'accueil", async () => {
    renderAt('/login', createFakeAuthClient({ initialSession: fakeSession() }))

    await waitFor(() => expect(homeScreen()).toBeInTheDocument())
  })
})

describe('le parcours complet', () => {
  it('connexion, puis déconnexion, ramène au formulaire', async () => {
    const client = renderAt('/', createFakeAuthClient())
    await waitFor(() => expect(loginScreen()).toBeInTheDocument())

    await userEvent.type(screen.getByLabelText('Téléphone'), 'patron@merx.test')
    await userEvent.type(screen.getByLabelText('Mot de passe'), 'motdepasse')
    await userEvent.click(screen.getByRole('button', { name: 'Se connecter' }))

    await waitFor(() => expect(homeScreen()).toBeInTheDocument())
    expect(screen.getByText('patron@merx.test')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Se déconnecter' }))

    await waitFor(() => expect(loginScreen()).toBeInTheDocument())
    expect(client.calls.signOut).toHaveBeenCalled()
  })
})
