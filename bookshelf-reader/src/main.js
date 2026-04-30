import { createApp } from 'vue'
import App from './App.vue'
import './styles/index.css'

// jQuery 和 turn.js 已通过全局 <script> 加载

const app = createApp(App)
app.mount('#app')
