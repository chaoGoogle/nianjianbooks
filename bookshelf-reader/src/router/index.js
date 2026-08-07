import { createRouter, createWebHistory } from 'vue-router'

const base = window.location.pathname.startsWith('/nianjian') ? '/nianjian/' : '/'

const routes = [
  {
    path: '/:bookName?',
    name: 'book',
    component: { render() {} }
  }
]

const router = createRouter({
  history: createWebHistory(base),
  routes
})

export default router
