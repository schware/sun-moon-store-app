// 셸의 셋업 화면. 토큰은 여기서 보지 않습니다 — main 이 받아 암호화해 둡니다.
(async () => {
  const form = document.getElementById('pair')
  const code = document.getElementById('code')
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
    submit.textContent = '확인 중…'
    try {
      const result = await setup.pair(server.value, code.value)
      if (!result.ok) {
        error.textContent = result.error
        error.hidden = false
      }
      // 성공하면 main 이 역할의 화면을 엽니다.
    } catch (e) {
      error.textContent = '페어링하지 못했습니다'
      error.hidden = false
    } finally {
      submit.disabled = false
      submit.textContent = '페어링'
    }
  })
})()
