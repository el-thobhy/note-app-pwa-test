using Azure;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Mvc;
using NoteAppPWA.Models;
using NoteAppPWA.Services;
using System.Security.Claims;

namespace NoteAppPWA.Controllers
{
    public class SettingsController : BaseController
    {
        private readonly ISettingServices _settingServices;
        public SettingsController(ISettingServices settingServices)
        {
            _settingServices = settingServices;
        }
        public IActionResult Index()
        {
            return View();
        }

        [HttpPost]
        [ValidateAntiForgeryToken]
        public async Task<IActionResult> UpdateProfilePhotos(IFormFile file)
        {
            try
            {
                var id = User.FindFirst("ID")?.Value;
                var result = await _settingServices.UpdateProfilePhoto(id,UserId, file);
                // update session agar view pakai foto terbaru
                if (result.Success)
                {
                    var identity = (ClaimsIdentity)User.Identity;

                    // hapus claim lama Avatar
                    var avatarClaim = identity.FindFirst("Avatar");
                    if (avatarClaim != null)
                        identity.RemoveClaim(avatarClaim);

                    // tambah claim baru
                    identity.AddClaim(new Claim("Avatar", result.Data.ProfilePhoto ?? ""));

                    // re-issue cookie
                    var principal = new ClaimsPrincipal(identity);
                    await HttpContext.SignInAsync(
                        CookieAuthenticationDefaults.AuthenticationScheme,
                        principal,
                        new AuthenticationProperties { IsPersistent = true }
                    );

                    return Ok(new
                    {
                        success = true,
                        message = "Profile Updated",
                        data = result.Data.ProfilePhoto
                    });
                }
                else
                {
                    return BadRequest(new
                    {
                        success = false,
                        message = result.Message
                    });

                }

            }
            catch (Exception e)
            {
                return BadRequest(new
                {
                    success=false,
                    message=e.Message
                });
            }
        }

        [HttpPost]
        [ValidateAntiForgeryToken]
        public async Task<IActionResult> UpdateProfile(UpdateViewModel request)
        {
            try
            {
                request.Id = User.FindFirst("ID")?.Value;
                var result = await _settingServices.UpdateFirstLast(request, UserId);
                if (result.Success) {
                    // Ambil identity sekarang
                    var identity = (ClaimsIdentity)User.Identity;

                    // Hapus claim lama kalau ada
                    var firstNameClaim = identity.FindFirst("FirstName");
                    if (firstNameClaim != null) identity.RemoveClaim(firstNameClaim);

                    var lastNameClaim = identity.FindFirst("LastName");
                    if (lastNameClaim != null) identity.RemoveClaim(lastNameClaim);

                    var fullNameClaim = identity.FindFirst("FullName");
                    if (fullNameClaim != null) identity.RemoveClaim(fullNameClaim);

                    // Tambahkan claim baru sesuai update
                    identity.AddClaim(new Claim("FirstName", result.Data.FirstName ?? ""));
                    identity.AddClaim(new Claim("LastName", result.Data.LastName ?? ""));
                    identity.AddClaim(new Claim("FullName", (result.Data.FirstName + " " + result.Data.LastName) ?? ""));

                    // Re-issue cookie agar perubahan tersimpan
                    var principal = new ClaimsPrincipal(identity);
                    await HttpContext.SignInAsync(
                        CookieAuthenticationDefaults.AuthenticationScheme,
                        principal,
                        new AuthenticationProperties { IsPersistent = true }
                    );

                    return Ok(new
                    {
                        success = true,
                        message = "Profile Updated",
                        data = result.Data
                    });
                }
                else
                {
                    return BadRequest(new
                    {
                        success = false,
                        message = result.Message
                    });
                }
            }
            catch (Exception e)
            {
                return BadRequest(new
                {
                    success=false,
                    message=e.Message
                });
            }
        }



        [HttpPost]
        [ValidateAntiForgeryToken]
        public async Task<IActionResult> ChangePassword(UpdatePasswordViewModel request)
        {
            try
            {
                var result = await _settingServices.UpdatePassword(request);
                if (result.Success)
                {
                    return Ok(new
                    {
                        success = true,
                        message = "Profile Updated",
                        data = result.Data
                    });
                }
                else
                {
                    return BadRequest(new
                    {
                        success = false,
                        message = result.Message
                    });
                }
            }
            catch (Exception e)
            {
                return BadRequest(new
                {
                    success = false,
                    message = e.Message
                });
            }
        }



        public IActionResult Security()
        {
            return View();
        }
    }
}
