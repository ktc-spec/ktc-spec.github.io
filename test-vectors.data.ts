// Build-time loader: the /test-vectors page renders straight from the generated
// artifacts, so the page and the published JSON can never disagree.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = join(process.cwd(), 'public', 'vectors')

export default {
  watch: ['public/vectors/index.json'],
  load() {
    const index = JSON.parse(readFileSync(join(DIR, 'index.json'), 'utf8'))
    const vectors = index.vectors.map((v: { file: string }) =>
      JSON.parse(readFileSync(join(DIR, v.file), 'utf8')),
    )
    return { index, vectors }
  },
}
