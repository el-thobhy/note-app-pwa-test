using ELAuth.Services;
using ELAuth.ViewModel;
using Microsoft.AspNetCore.Mvc;

namespace NoteApp.Controllers
{
    public class AuthController : Controller
    {
        private readonly AuthServices _AuthServices;
        public AuthController(IConfiguration config)
        {
            _AuthServices = new AuthServices(config["ApiUrl"]);
        }
        public IActionResult Index()
        {
            return View();
        }
        [HttpPost]
        [ValidateAntiForgeryToken]
        public async Task<IActionResult> SigningIn([FromBody] LoginRequestViewModel model)
        {
            try
            {
                // Panggil login service
                var response = await _AuthServices.LoginAsync(model);

                // Cek jika login gagal atau token tidak ada
                if (!response.Success || response.Data == null || string.IsNullOrEmpty(response.Data.Token))
                {
                    return Json(new
                    {
                        success = false,
                        message = response.Message ?? "Login failed. Invalid credentials."
                    });
                }

                // Simpan token ke session jika perlu
                HttpContext.Session.SetString("Token", response.Data.Token ?? "");
                HttpContext.Session.SetString("UserName", response.Data.UserName ?? "");
                HttpContext.Session.SetString("Avatar", response.Data.ProfilePhoto ?? "");
                HttpContext.Session.SetString("FullName", (response.Data.FirstName + " " + response.Data.LastName) ?? "");
                HttpContext.Session.SetString("FirstName", response.Data.FirstName ?? "");
                HttpContext.Session.SetString("LastName", response.Data.LastName ?? "");
                HttpContext.Session.SetString("Email", response.Data.Email ?? "");
                HttpContext.Session.SetString("ID", response.Data.Id.ToString() ?? "");



                // Kembalikan respons sukses
                return Json(new
                {
                    success = true,
                    message = "Login successful. Welcome, " + response.Data.FirstName + "!"
                });
            }
            catch (Exception ex)
            {
                // Tangani pengecualian dan kembalikan respons error
                return Json(new
                {
                    success = false,
                    message = "An error occurred while processing your request: " + ex.Message
                });
            }
        }


        [HttpPost]
        [ValidateAntiForgeryToken]
        public async Task<IActionResult> RegisterAccount([FromBody] RegisterViewModel model)
        {
            var result = await _AuthServices.RegisterAccountAsync(model);
            if (result.IsSuccess)
            {
                return Ok(result.Message);
            }

            return BadRequest(result.Message);
        }
        [HttpPost]
        public async Task<IActionResult> VerifyOtp([FromBody] OtpViewModel model)
        {
            var result = await _AuthServices.VerifyOtpAsync(model);

            if (result.IsSuccess)
                return Ok(result.Message);

            return BadRequest(result.Message);
        }
        [HttpPost]
        public async Task<IActionResult> ResendOtp([FromBody] string email)
        {
            var result = await _AuthServices.SendOtpAsync(email);
            if (result)
                return Ok();
            return BadRequest("Gagal mengirim OTP. Periksa email Anda.");
        }


        [HttpPost]
        public IActionResult Logout()
        {
            HttpContext.Session.Clear();

            return RedirectToAction("Index", "Auth");
        }
        public IActionResult Unauthorized()
        {
            return View();
        }

    }
}
