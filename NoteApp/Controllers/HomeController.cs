using System.Diagnostics;
using Microsoft.AspNetCore.Mvc;
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
            List<Note> notes = _noteService.GetAllNotes();
            return View(notes);
        }

        // GET: /Home/Create
        public IActionResult Create()
        {
            return View();
        }

        // POST: /Home/Create
        [HttpPost]
        [ValidateAntiForgeryToken]
        public IActionResult Create(Note note)
        {
            if (ModelState.IsValid)
            {
                note.Created_by = "admin"; // Bisa ganti dengan user login
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
            if (ModelState.IsValid)
            {
                note.Modified_by = "admin"; // Ganti sesuai user
                _noteService.UpdateNote(note);
                return RedirectToAction(nameof(Index));
            }
            return View(note);
        }

        // GET: /Home/Delete/5
        public IActionResult Delete(int id)
        {
            var note = _noteService.GetNoteById(id);
            if (note == null) return NotFound();
            return View(note);
        }

        // POST: /Home/Delete/5
        [HttpPost, ActionName("Delete")]
        [ValidateAntiForgeryToken]
        public IActionResult DeleteConfirmed(int id)
        {
            _noteService.DeleteNote(id, "admin"); // Ganti dengan user login
            return RedirectToAction(nameof(Index));
        }
    }
}
