using NoteApp.Models;

namespace NoteApp.Services
{
    public interface INoteService
    {
        void CreateNote(Note note);
        List<Note> GetAllNotes();
        Note? GetNoteById(int id);
        void UpdateNote(Note note);
        void DeleteNote(int id, string? deletedBy);
    }

}
