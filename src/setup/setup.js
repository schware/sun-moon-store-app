// 셸의 설정 화면 — 매장·장비·하는 일을 정합니다. 저장은 main 이 합니다.
(async () => {
  const form = document.getElementById('register')
  const kind = document.getElementById('kind')
  const store = document.getElementById('store')
  const device = document.getElementById('device')
  const server = document.getElementById('server')
  const error = document.getElementById('error')
  const submit = document.getElementById('submit')

  const setup = window.sunmoon && window.sunmoon.setup
  if (!setup) {
    error.textContent = '셸 밖에서 열린 화면입니다.'
    error.hidden = false
    submit.disabled = true
    return
  }
  const defaults = await setup.defaults()
  server.value = (defaults && defaults.serverUrl) || ''

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    error.hidden = true
    submit.disabled = true
    try {
      const result = await setup.save(server.value, store.value, device.value, kind.value)
      if (!result.ok) {
        error.textContent = result.error
        error.hidden = false
      }
      // 성공하면 main 이 그 일의 화면을 엽니다.
    } catch (e) {
      error.textContent = '저장하지 못했습니다'
      error.hidden = false
    } finally {
      submit.disabled = false
    }
  })
})()
