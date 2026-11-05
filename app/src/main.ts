import { createBackend } from './backend.ts'
import { mount } from './view.ts'

const root = document.getElementById('app')
if (!root) throw new Error('#app missing')

void createBackend().then((backend) => mount(root, backend))
