using ELAuth.Helper;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using NoteApp.Services;

namespace NoteApp.Helper
{
    public class UserIdAuthorizeAttribute : Attribute, IAuthorizationFilter
    {
        public void OnAuthorization(AuthorizationFilterContext context)
        {
            var httpContext = context.HttpContext;
            var token = httpContext.Session.GetString("Token");
            if(string.IsNullOrEmpty(token))
            {
                // Jika token tidak ada, redirect ke halaman login
                context.Result = new RedirectToActionResult("Index", "Auth", null);
                return;
            }

            //mengambil userId dari token
            string? userId = JwtHelper.GetName(token);
            if (string.IsNullOrEmpty(userId))
            {
                context.Result = new RedirectToActionResult("Unauthorized", "Auth",null);
                return;
            }

            // Ambil userId dari route/data (misal dari query atau route parameter)
            // Contoh: asumsikan ada parameter "id" di route (/.home/{id})
            var query = context.HttpContext.Request.Query;
            if (!query.ContainsKey("id") || string.IsNullOrEmpty(query["id"]))
            {
                context.Result = new RedirectToActionResult("Unauthorized", "Auth", null);
                return;
            }
            if (!int.TryParse(query["id"], out int id))
            {
                context.Result = new RedirectToActionResult("Unauthorized", "Auth", null);
                return;
            }

            //Ambil service untuk akses database
            INoteService? noteService = httpContext.RequestServices.GetService(typeof(INoteService)) as INoteService;
            if(noteService == null)
            {
                context.Result = new StatusCodeResult(500); // Internal Server Error jika service tidak ditemukan
                return;
            }

            int noteId = Convert.ToInt32(id);
            // Cek apakah note dengan id tersebut milik user yang sedang login
            var note = noteService.GetNoteById(noteId);
            if(note == null || note.UserId != userId)
            {
                context.Result = new RedirectToActionResult("Unauthorized", "Auth", null);
                return;
            }
        }
    }
}
