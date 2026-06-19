import { createRouter, createWebHistory } from "vue-router";
import { authLoginUrl, normalizedBasePath } from "../lib/basePath";
import { useAuthStore } from "../stores/auth";
import HomeView from "../views/HomeView.vue";

export const router = createRouter({
  history: createWebHistory(normalizedBasePath()),
  routes: [
    {
      path: "/",
      name: "home",
      component: HomeView
    }
  ]
});

function usesOAuthMode(): boolean {
  return import.meta.env.VITE_AUTH_MODE === "oauth";
}

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  if (!auth.loaded) {
    await auth.restore();
  }

  if (usesOAuthMode() && auth.loading) {
    return false;
  }

  if (usesOAuthMode() && auth.loaded && !auth.authenticated && !auth.error) {
    window.location.assign(authLoginUrl(to.fullPath));
    return false;
  }

  return true;
});
