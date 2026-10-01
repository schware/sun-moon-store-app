// KIOSK 관리자 창. PIN 은 셸 main 이 서버에 물어 확인합니다 — 여기서 비교하지 않습니다.
(() => {
  const admin = window.sunmoon && window.sunmoon.kioskAdmin
  const form = document.getElementById('unlock')
  const pin = document.getElementById('pin')
  const error = document.getElementById('error')
  const submit = document.getElementById('submit')
  const actions = document.getElementById('actions')

  const show = (message) => { error.textContent = message; error.hidden = false }
  if (!admin) { show('셸 밖에서 열린 화면입니다.'); submit.disabled = true; return }

  document.getElementById('back').addEventListener('click', () => admin.act('back'))

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    error.hidden = true
    submit.disabled = true
    try {
      const result = await admin.unlock(pin.value)
      pin.value = ''
      if (result.ok) {
        form.hidden = true
        actions.hidden = false
      } else {
        show(result.error || 'PIN 이 맞지 않습니다')
      }
    } catch (e) {
      show('확인하지 못했습니다')
    } finally {
      submit.disabled = false
    }
  })

  for (const button of actions.querySelectorAll('button[data-act]')) {
    button.addEventListener('click', async () => {
      const act = button.getAttribute('data-act')
      if (act === 'forget' && !confirm('이 KIOSK 의 매장·장비 설정을 지웁니다. 설정 화면으로 돌아갑니다.')) return
      const result = await admin.act(act)
      if (result && result.error) show(result.error)
    })
  }
})()
