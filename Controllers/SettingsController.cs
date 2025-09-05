using Azure;
using Microsoft.AspNetCore.Mvc;
using NoteAppPWA.Models;
using NoteAppPWA.Services;

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
                var id = HttpContext.Session.GetString("ID");
                var result = await _settingServices.UpdateProfilePhoto(id,UserId, file);
                // update session agar view pakai foto terbaru
                if (result.Success)
                {
                    HttpContext.Session.SetString("Avatar", result.Data.ProfilePhoto);
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
                request.Id = HttpContext.Session.GetString("ID");
                var result = await _settingServices.UpdateFirstLast(request, UserId);
                if (result.Success) { 
                    // update session agar view pakai foto terbaru
                    HttpContext.Session.SetString("FirstName", result.Data.FirstName ?? "");
                    HttpContext.Session.SetString("LastName", result.Data.LastName ?? "");
                    HttpContext.Session.SetString("FullName", (result.Data.FirstName + " " + result.Data.LastName) ?? "");

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

        public IActionResult Security()
        {
            return View();
        }
    }
}
