using System.Diagnostics;
using ELAuth.Helper;
using Microsoft.AspNetCore.Mvc;
using Newtonsoft.Json.Linq;
using NoteApp.Helper;
using NoteApp.Models;
using NoteApp.Services;

namespace NoteApp.Controllers
{
    public class HomeController : Controller
    {
        private readonly INoteService _noteService;

        public HomeController(INoteService noteService)
        {
            _noteService = noteService;
        }
        // GET: /Home/Index
        public IActionResult Index()
        {
            var token = HttpContext.Session.GetString("Token");
            if (string.IsNullOrEmpty(token))
            {
                return RedirectToAction("Index", "Auth");
            }
            string[]? roles = JwtHelper.GetRolesFromToken(token);
            HttpContext.Session.SetString("Roles", string.Join(",", roles ?? new string[] { }));

            string? userId = JwtHelper.GetName(token);
            List<Note> notes = [];
            List<DailyEntry> entries = [];
            if (userId == "admin")
            {
                notes = _noteService.GetAllNotes();
                for (int i = 0; i < notes.Count; i++)
                {
                    notes[i].Entries = _noteService.GetAllDailyEntriesByNoteId(notes[i].Id);
                }
            }
            else
            {
                notes = _noteService.GetAllNotesByUserId(userId);
                for(int i = 0; i< notes.Count; i++)
                {
                    notes[i].Entries = _noteService.GetAllDailyEntriesByNoteId(notes[i].Id);
                }
            }
            return View(notes);
        }

        // POST: /Home/Create
        [HttpPost]
        [ValidateAntiForgeryToken]
        public IActionResult Create(Note note)
        {
            if (ModelState.IsValid)
            {
                var token = HttpContext.Session.GetString("Token");
                if (string.IsNullOrEmpty(token))
                {
                    return RedirectToAction("Index", "Auth");
                }
                string? userId = JwtHelper.GetName(token);
                note.Created_by = userId; // Bisa ganti dengan user login
                note.UserId = userId; // Bisa ganti dengan user login
                _noteService.CreateNote(note);
                return RedirectToAction(nameof(Index));
            }
            return View(note);
        }

        // GET: /Home/Edit/5
        [HttpGet]
        public IActionResult Edit(int id)
        {
            var note = _noteService.GetNoteById(id);
            if (note == null) return NotFound();
            return PartialView(note);
        }

        // POST: /Home/Edit/5
        [HttpPost]
        [ValidateAntiForgeryToken]
        public IActionResult Edit(Note note)
        {
            var token = HttpContext.Session.GetString("Token");
            if (ModelState.IsValid)
            {
                string? userId = JwtHelper.GetName(token);
                note.Modified_by = userId; // Ganti sesuai user
                _noteService.UpdateNote(note);
                return RedirectToAction(nameof(Index));
            }
            return View(note);
        }

        // GET: /Home/Delete/5
        [UserIdAuthorize]
        public IActionResult Delete(int id)
        {
            var note = _noteService.GetNoteById(id);
            if (note == null) return NotFound();
            return View(note);
        }

        // POST: /Home/Delete/5
        [HttpPost]
        [UserIdAuthorize]
        public IActionResult DeleteConfirmed(int id)
        {
            var token = HttpContext.Session.GetString("Token");
            string? userId = JwtHelper.GetName(token);
            _noteService.DeleteNote(id, userId); // Ganti dengan user login
            return RedirectToAction(nameof(Index));
        }
    }
}
