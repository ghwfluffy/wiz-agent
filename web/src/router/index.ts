import { createRouter, createWebHistory } from "vue-router";
import { normalizedBasePath } from "../lib/basePath";
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
