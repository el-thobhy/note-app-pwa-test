using ELAuth.Services;
using ELAuth.ViewModel;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Mvc;
using System.Security.Claims;

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

                // 🟢 Simpan info user di cookie biasa (bisa dibaca JS/UI)
                var claims = new List<Claim>
                {
                    new Claim("ID", response.Data.Id.ToString()),
                    new Claim("FullName", $"{response.Data.FirstName} {response.Data.LastName}".ToString()),
                    new Claim("FirstName", response.Data.FirstName),
                    new Claim("LastName", response.Data.LastName),
                    new Claim("Avatar", response.Data.ProfilePhoto ?? ""),
                    new Claim("Token", response.Data.Token ?? ""),
                    new Claim(ClaimTypes.Name, response.Data.UserName ?? ""),
                    new Claim(ClaimTypes.Email, response.Data.Email ?? "")
                };


                var identity = new ClaimsIdentity(claims, CookieAuthenticationDefaults.AuthenticationScheme);
                var principal = new ClaimsPrincipal(identity);

                await HttpContext.SignInAsync(CookieAuthenticationDefaults.AuthenticationScheme, principal, new AuthenticationProperties
                {
                    IsPersistent = true, // Ingat saya
                    ExpiresUtc = DateTimeOffset.UtcNow.AddHours(1) // Sesuaikan dengan kebutuhan
                });

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
        public async Task<IActionResult> Logout()
        {
            HttpContext.Session.Clear();
            await HttpContext.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);


            return RedirectToAction("Index", "Auth");
        }
        public IActionResult Unauthorized()
        {
            return View();
        }

    }
}
